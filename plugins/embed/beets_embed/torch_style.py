"""Convert only the operators used by the pinned Style ONNX assets to Torch."""

from pathlib import Path

import numpy as np
import onnx
import torch
from onnx import numpy_helper
from torch import fx, nn
from torch.nn import functional as F


HEADS = ("moodtheme", "instrument", "approachability", "engagement")


def configure_fp32(threads):
    torch.set_num_threads(threads)
    torch.set_float32_matmul_precision("highest")
    torch.backends.cuda.matmul.allow_tf32 = False
    torch.backends.cudnn.allow_tf32 = False
    torch.backends.cudnn.benchmark = False
    torch.backends.cudnn.deterministic = True
    torch.use_deterministic_algorithms(True)


def flatten(value, axis=1):
    # ONNX Flatten always returns rank two, including axis=0 or axis=rank.
    axis = axis if axis >= 0 else value.ndim + axis
    return value.reshape(int(np.prod(value.shape[:axis])),
                         int(np.prod(value.shape[axis:])))


def convert(path, extra_outputs=()):
    """Load local weights into an FX module; fail closed on other ONNX graphs.

    FX releases dead intermediate tensors and avoids interpreting the ONNX graph
    on every patch. No architecture library or independently trained weights are
    involved. Extra tensor names are used only by the parity tool.
    """
    model = onnx.load(str(path), load_external_data=False)
    if any(t.data_location == onnx.TensorProto.EXTERNAL for t in model.graph.initializer):
        raise ValueError("External ONNX weights are not supported")
    onnx.checker.check_model(model)
    if any(o.domain == "" and o.version not in (11, 13) for o in model.opset_import):
        raise ValueError("Unsupported Style ONNX opset")
    root, graph, values = nn.Module(), fx.Graph(), {}
    for index, tensor in enumerate(model.graph.initializer):
        array = numpy_helper.to_array(tensor).copy()
        if array.dtype != np.float32 or not np.isfinite(array).all():
            raise ValueError(f"Expected finite fp32 weights: {tensor.name}")
        name = f"weight_{index}"
        root.register_buffer(name, torch.from_numpy(array))
        values[tensor.name] = graph.get_attr(name)
    inputs = [item for item in model.graph.input if item.name not in values]
    if len(inputs) != 1:
        raise ValueError("Expected one Style ONNX input")
    values[inputs[0].name] = graph.placeholder("batch")
    allowed = {
        "Conv": {"dilations", "group", "kernel_shape", "pads", "strides"},
        "Gemm": {"alpha", "beta", "transA", "transB"},
        "Flatten": {"axis"}, "Unsqueeze": {"axes"},
        "GlobalAveragePool": set(), "Identity": set(), "Sigmoid": set(),
        "Relu": set(), "Mul": set(), "Add": set(), "MatMul": set(),
    }
    for node in model.graph.node:
        attrs = {a.name: onnx.helper.get_attribute_value(a) for a in node.attribute}
        op = node.op_type
        if (node.domain or op not in allowed or len(node.output) != 1 or
                set(attrs) - allowed[op]):
            raise ValueError(f"Unsupported Style ONNX node: {node.name} ({op})")
        try:
            args = [values[name] for name in node.input]
        except KeyError as exc:
            raise ValueError(f"Unresolved Style ONNX input: {exc}") from exc
        if op == "Conv":
            pads = attrs.get("pads", [0, 0, 0, 0])
            if len(pads) != 4 or pads[:2] != pads[2:]:
                raise ValueError("Expected symmetric 2D Style convolution padding")
            value = graph.call_function(F.conv2d, tuple(args), {
                "stride": tuple(attrs.get("strides", [1, 1])),
                "padding": tuple(pads[:2]),
                "dilation": tuple(attrs.get("dilations", [1, 1])),
                "groups": attrs.get("group", 1),
            })
        elif op == "Gemm":
            left, right = args[:2]
            if attrs.get("transA", 0):
                left = graph.call_method("transpose", (left, 0, 1))
            if attrs.get("transB", 0):
                right = graph.call_method("transpose", (right, 0, 1))
            value = graph.call_function(torch.matmul, (left, right))
            value = graph.call_function(torch.mul, (value, attrs.get("alpha", 1.0)))
            if len(args) == 3:
                bias = graph.call_function(torch.mul, (args[2], attrs.get("beta", 1.0)))
                value = graph.call_function(torch.add, (value, bias))
        elif op == "Unsqueeze":
            value = args[0]
            rank = len(attrs["axes"]) + 3  # pinned input is [batch, 128, 96]
            for axis in sorted(a if a >= 0 else rank + a for a in attrs["axes"]):
                value = graph.call_function(torch.unsqueeze, (value, axis))
        elif op == "GlobalAveragePool":
            value = graph.call_method("mean", (args[0], (-2, -1)), {"keepdim": True})
        elif op == "Flatten":
            value = graph.call_function(flatten, (args[0], attrs.get("axis", 1)))
        elif op == "Identity":
            value = args[0]
        else:
            function = {"Sigmoid": torch.sigmoid, "Relu": F.relu, "Mul": torch.mul,
                        "Add": torch.add, "MatMul": torch.matmul}[op]
            value = graph.call_function(function, tuple(args))
        values[node.output[0]] = value
    names = [item.name for item in model.graph.output] + list(extra_outputs)
    graph.output(tuple(values[name] for name in names))
    graph.lint()
    return fx.GraphModule(root, graph).eval()


def discogs_logit_name(path):
    model = onnx.load(str(path), load_external_data=False)
    output = next(node for node in model.graph.node if "activations" in node.output)
    if output.op_type != "Sigmoid":
        raise ValueError("Expected sigmoid Discogs activations")
    return output.input[0]


class TorchStyle:
    def __init__(self, assets, device, threads):
        configure_fp32(threads)
        self.device = device
        assets = Path(assets)
        self.effnet = convert(assets / "effnet.onnx").to(device)
        self.heads = {name: convert(assets / f"{name}.onnx").to(device) for name in HEADS}

    def batch(self, batch):
        with torch.inference_mode():
            outputs = self.effnet(torch.from_numpy(batch).to(self.device))
            vectors = next(value for value in outputs if value.shape[-1] == 1280)
            scores = next(value for value in outputs if value.shape[-1] == 400)
            values = {"embeddings": vectors, "discogs400": scores}
            for name, module in self.heads.items():
                values[name] = module(vectors)[0].reshape(len(vectors), -1)
            return {name: value.cpu().numpy() for name, value in values.items()}
