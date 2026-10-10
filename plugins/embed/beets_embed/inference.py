"""Pinned ONNX EffNet and strict, entirely offline AMCLAP inference."""

import importlib
import json
import os
import sys
from contextlib import redirect_stdout
from pathlib import Path

import numpy as np

from .audio import amclap_windows, batches, effnet_patches
from .retrieval import unit


def onnx_options(threads):
    """Bound session pools and let idle inference threads sleep."""
    import onnxruntime as ort
    options = ort.SessionOptions()
    options.intra_op_num_threads = threads
    options.inter_op_num_threads = 1
    options.execution_mode = ort.ExecutionMode.ORT_SEQUENTIAL
    options.add_session_config_entry("session.intra_op.allow_spinning", "0")
    options.add_session_config_entry("session.inter_op.allow_spinning", "0")
    return options


class Moments:
    def __init__(self):
        self.count = 0
        self.mean = None
        self.m2 = None

    def add(self, values):
        values = np.asarray(values, dtype="f8")
        if values.ndim != 2 or not np.isfinite(values).all():
            raise ValueError("Invalid model output")
        n = len(values)
        mean = values.mean(axis=0)
        m2 = ((values - mean) ** 2).sum(axis=0)
        if self.count == 0:
            self.mean, self.m2 = mean, m2
        else:
            delta = mean - self.mean
            self.mean += delta * n / (self.count + n)
            self.m2 += m2 + delta ** 2 * self.count * n / (self.count + n)
        self.count += n

    def result(self):
        if not self.count:
            raise ValueError("No audio windows produced")
        return self.mean.astype("f4"), np.sqrt(self.m2 / self.count).astype("f4")


def strict_checkpoint(module, checkpoint):
    """Published AMCLAP flattens OMAR's keys; account for every inference tensor."""
    expected = module.state_dict()
    mapped = {}
    for key, value in checkpoint.items():
        target = "audio_encoder.model." + key if key.startswith(("net.", "embedding_layer.")) else key
        if target not in expected:
            raise ValueError(f"Unexpected checkpoint tensor: {key}")
        if target in mapped:
            raise ValueError(f"Duplicate checkpoint tensor: {target}")
        mapped[target] = value
    # strict=True also catches missing text weights, buffers and shape mismatches.
    module.load_state_dict(mapped, strict=True)


class Models:
    def __init__(self, assets, threads=2, device="cpu", text_only=False, style_backend="onnx"):
        if style_backend not in ("onnx", "torch"):
            raise ValueError(f"Unknown Style backend: {style_backend}")
        self.assets = Path(assets)
        self.threads = threads
        self.device = device
        self.text_only = text_only
        self.style_backend = style_backend
        self._torch_style = None
        self.effnet = None
        self.heads = {}
        self.amclap = None
        if not text_only and style_backend == "torch":
            from .torch_style import TorchStyle
            self._torch_style = TorchStyle(self.assets, device, threads)
            self.heads = self._torch_style.heads
        elif not text_only:
            import onnxruntime as ort
            options = onnx_options(threads)
            def session(name):
                return ort.InferenceSession(str(self.assets / f"{name}.onnx"), options,
                                            providers=["CPUExecutionProvider"])
            self.effnet = session("effnet")
            for name in ("moodtheme", "instrument", "approachability", "engagement"):
                self.heads[name] = session(name)

    def load_text(self):
        if self.amclap is not None:
            return
        with redirect_stdout(sys.stderr):
            self._load_text()

    def configure_threads(self):
        from .threads import configure_torch_threads
        configure_torch_threads(self.threads)

    def _load_text(self):
        self.configure_threads()
        os.environ.update(HF_HUB_OFFLINE="1", TRANSFORMERS_OFFLINE="1",
                          TOKENIZERS_PARALLELISM="false")
        import torch
        import gin
        import huggingface_hub
        # OMAR's loader expects Hub IDs; resolve only the pinned local config.
        # No network/cache fallback is possible, including for unexpected assets.
        def local_asset(repo_id, filename, **kwargs):
            if repo_id == "mtg-upf/clap_omarrq_mp_small_music" and filename == "config.gin":
                return str(self.assets / "omar.gin")
            if repo_id == "mtg-upf/clap_omarrq_mp_small_music" and filename == "model.ckpt":
                return str(self.assets / "amclap.ckpt")  # load_weights=False: never read
            raise ValueError(f"Unpinned model asset requested: {repo_id}/{filename}")
        huggingface_hub.hf_hub_download = local_asset
        import amclap
        from amclap.def_module import ensure_registered
        ensure_registered("lejepa")
        config = (self.assets / "amclap.gin").read_text()
        config = config.replace("AllMPNetBaseV2.local_files_only = False",
                                "AllMPNetBaseV2.local_files_only = True")
        config = config.replace("'sentence-transformers/all-mpnet-base-v2'",
                                repr(str(self.assets / "mpnet")))
        amclap._register_referenced_modules(config)
        gin.clear_config()
        gin.parse_config(config, skip_unknown=True)
        gin.bind_parameter("OMARRQ.load_weights", False)
        factory = importlib.import_module("amclap.def_module").def_module
        module = factory(ckpt_path=None)
        # OMAR allocates a pretraining quantizer-logit head even in inference
        # mode. extract_embeddings never calls it, and AMCLAP intentionally
        # omits its weights. Remove that unused head before the strict load.
        del module.audio_encoder.model.linear
        checkpoint = torch.load(self.assets / "amclap.ckpt", map_location="cpu", weights_only=True)
        strict_checkpoint(module, checkpoint)
        # Keep strict validation of the published checkpoint, but retain only
        # text inference modules in a long-lived text-only worker.
        del checkpoint
        if self.text_only:
            del module.audio_encoder, module.proj_a
        self.amclap = module.eval().to(self.device)

    def text(self, text):
        return self.text_batch([text])[0]

    def text_batch(self, texts):
        self.load_text()
        import torch
        with torch.inference_mode():
            return unit(self.amclap.forward_text(texts).cpu().numpy())

    def style_batch(self, batch):
        """Unaggregated patch outputs shared by inference and parity tooling."""
        if self._torch_style is not None:
            return self._torch_style.batch(batch)
        outputs = self.effnet.run(None, {self.effnet.get_inputs()[0].name: batch})
        vectors = next(value for value in outputs if value.shape[-1] == 1280)
        styles = next(value for value in outputs if value.shape[-1] == 400)
        values = {"embeddings": vectors, "discogs400": styles}
        for name, session in self.heads.items():
            output = session.run(None, {session.get_inputs()[0].name: vectors})[0]
            values[name] = output.reshape(len(vectors), -1)
        return values

    def style(self, prepared, batch_size):
        return self.style_batches(batches(effnet_patches(prepared.samples(16000)), batch_size))

    def style_batches(self, prepared_batches):
        moments = Moments()
        head_moments = {name: Moments() for name in ("discogs400", *self.heads)}
        for batch in prepared_batches:
            values = self.style_batch(batch)
            moments.add(values["embeddings"])
            for name, stats in head_moments.items():
                stats.add(values[name])
        heads = {}
        for name, stats in head_moments.items():
            meta_name = "effnet" if name == "discogs400" else name
            meta = json.loads((self.assets / f"{meta_name}.json").read_text())
            heads[name] = {"labels": meta.get("classes", [name]),
                           "scores": stats.result()[0].tolist()}
        mean, std = moments.result()
        return mean, std, heads, moments.count

    def audio_text(self, prepared, batch_size):
        self.load_text()
        import torch
        moments = Moments()
        samples = prepared.samples(24000)
        with torch.inference_mode():
            for batch in batches(amclap_windows(samples), batch_size):
                values = self.amclap.forward_audio(torch.from_numpy(batch).to(self.device))
                moments.add(unit(values.cpu().numpy()))
        mean, std = moments.result()
        return mean, std, {}, moments.count
