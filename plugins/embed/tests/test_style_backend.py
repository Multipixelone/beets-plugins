import importlib.util
import json
import os
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

import numpy as np

from beets_embed.inference import Models
from beets_embed.store import model_ids


class BackendSelectionTests(unittest.TestCase):
    def test_invalid_backend(self):
        with self.assertRaisesRegex(ValueError, "Unknown Style backend"):
            Models("/unused", style_backend="typo")

    def test_default_does_not_import_conversion_stack(self):
        with patch.dict("sys.modules", {"beets_embed.torch_style": None}):
            engine = Models("/unused", text_only=True)
        self.assertEqual(engine.style_backend, "onnx")
        self.assertIsNone(engine._torch_style)

    def test_worker_selection_and_identity(self):
        from beets_embed.worker import main
        before = model_ids()
        class Loaded(Exception):
            pass
        for environment, flag, expected in (({}, [], "onnx"),
                ({"BEETS_EMBED_STYLE_BACKEND": "torch"}, [], "torch"),
                ({"BEETS_EMBED_STYLE_BACKEND": "torch"}, ["--style-backend", "onnx"], "onnx")):
            with patch.dict(os.environ, environment, clear=True), \
                 patch("sys.argv", ["worker", "smoke", "--device", "cpu", "--assets", "/assets", *flag]), \
                 patch("beets_embed.inference.Models", side_effect=Loaded) as model:
                with self.assertRaises(Loaded):
                    main()
                self.assertEqual(model.call_args.kwargs["style_backend"], expected)
                self.assertEqual(model_ids(), before)

    def test_handoff_preserves_explicit_backend(self):
        from beets_embed.worker import main
        class HandedOff(Exception):
            pass
        with patch.dict(os.environ, {}, clear=True), \
             patch("sys.argv", ["worker", "smoke", "--assets", "/assets", "--style-backend", "torch"]), \
             patch("beets_embed.worker.select_worker", return_value=("/rocm", "rocm")), \
             patch("beets_embed.worker.os.execv", side_effect=HandedOff) as launch:
            with self.assertRaises(HandedOff):
                main()
            command = launch.call_args.args[1]
            self.assertEqual(command[command.index("--style-backend") + 1], "torch")


@unittest.skipUnless(all(importlib.util.find_spec(name) for name in ("torch", "onnx", "onnxruntime")),
                     "Torch/ONNX runtime tests run in the packaged worker environment")
class ConversionTests(unittest.TestCase):
    def test_grouped_convolution_residual_and_gemm_against_onnx(self):
        import onnx
        import onnxruntime as ort
        import torch
        from onnx import TensorProto, helper, numpy_helper
        from beets_embed.torch_style import convert
        rng = np.random.default_rng(5)
        weights = [numpy_helper.from_array(value.astype("f4"), name) for name, value in (
            ("conv", rng.normal(size=(2, 1, 3, 3))),
            ("projection", rng.normal(size=(3, 2))),
            ("bias", rng.normal(size=(3,))))]
        nodes = [helper.make_node("Conv", ["input", "conv"], ["c"], pads=[1, 1, 1, 1], group=2),
                 helper.make_node("Sigmoid", ["c"], ["s"]),
                 helper.make_node("Mul", ["c", "s"], ["m"]),
                 helper.make_node("Add", ["m", "input"], ["a"]),
                 helper.make_node("GlobalAveragePool", ["a"], ["g"]),
                 helper.make_node("Flatten", ["g"], ["f"], axis=1),
                 helper.make_node("Gemm", ["f", "projection", "bias"], ["out"],
                                  transB=1, alpha=.5, beta=.25)]
        graph = helper.make_graph(nodes, "fixture", [helper.make_tensor_value_info(
            "input", TensorProto.FLOAT, [None, 2, 8, 6])], [helper.make_tensor_value_info(
            "out", TensorProto.FLOAT, [None, 3])], weights)
        model = helper.make_model(graph, opset_imports=[helper.make_opsetid("", 11)], ir_version=8)
        options = ort.SessionOptions()
        options.intra_op_num_threads = 2
        options.inter_op_num_threads = 1
        with tempfile.TemporaryDirectory() as temp:
            path = Path(temp) / "fixture.onnx"
            onnx.save(model, path)
            module = convert(path)
            session = ort.InferenceSession(str(path), options, providers=["CPUExecutionProvider"])
            for size in (1, 3):
                batch = rng.normal(size=(size, 2, 8, 6)).astype("f4")
                with torch.inference_mode():
                    actual = module(torch.from_numpy(batch))[0].numpy()
                np.testing.assert_allclose(actual, session.run(None, {"input": batch})[0],
                                           rtol=1e-5, atol=1e-5)
            model.graph.node[0].op_type = "Sin"
            del model.graph.node[0].input[1:]
            del model.graph.node[0].attribute[:]
            onnx.save(model, path)
            with self.assertRaisesRegex(ValueError, "Unsupported Style ONNX node"):
                convert(path)

    @unittest.skipUnless(os.environ.get("BEETS_EMBED_MODELS"), "pinned assets not configured")
    def test_pinned_models_and_aggregation(self):
        assets = os.environ["BEETS_EMBED_MODELS"]
        onnx_engine = Models(assets)
        torch_engine = Models(assets, style_backend="torch")
        rng = np.random.default_rng(41)
        prepared_batches = [rng.uniform(0, 4, (size, 128, 96)).astype("f4") for size in (3, 1)]
        for batch in prepared_batches:
            reference, actual = onnx_engine.style_batch(batch), torch_engine.style_batch(batch)
            self.assertEqual(list(reference), list(actual))
            for name in reference:
                np.testing.assert_allclose(actual[name], reference[name], rtol=1e-4, atol=1e-4)
        reference = onnx_engine.style_batches(prepared_batches)
        actual = torch_engine.style_batches(prepared_batches)
        for index in (0, 1):
            np.testing.assert_allclose(actual[index], reference[index], rtol=1e-4, atol=1e-4)
        self.assertEqual(actual[3], reference[3])
        self.assertEqual(json.dumps({name: head["labels"] for name, head in actual[2].items()}),
                         json.dumps({name: head["labels"] for name, head in reference[2].items()}))
