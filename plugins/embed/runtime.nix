# Keep AMCLAP's checkpoint-compatible text stack separate from beets' Python.
{ pkgs, lib, fetchurl, fetchzip, models, rocmSupport ? false }:
let
  python = pkgs.python313.override {
    packageOverrides = self: super: (lib.optionalAttrs rocmSupport {
      # Override torch alone: retain the cached, unmodified ROCm libraries.
      # Use the original scope to avoid torchWithRocm's self.torch recursion.
      torch = (pkgs.python313Packages.torchWithRocm.override {
        gpuTargets = [ "gfx1101" ];
      }).overridePythonAttrs (old: {
        # This pin's Torch 2.13 expects a newer AOTriton API than its 0.11.1b.
        # Disable optional fused attention in Torch, without rebuilding ROCm.
        # AMCLAP can use ordinary GPU attention instead.
        env = old.env // { USE_FLASH_ATTENTION = "0"; };
      });
      # Codec's upstream tests alone pull in a separate torchvision GPU build.
      # Keep its import check; the worker smoke exercises our audio/text path.
      torchcodec = super.torchcodec.overridePythonAttrs { doCheck = false; };
    }) // {
      huggingface-hub = self.buildPythonPackage {
        pname = "huggingface_hub";
        version = "0.36.2";
        pyproject = true;
        src = fetchurl {
          url = "https://files.pythonhosted.org/packages/7c/b7/8cb61d2eece5fb05a83271da168186721c450eb74e3c31f7ef3169fa475b/huggingface_hub-0.36.2.tar.gz";
          sha256 = "1934304d2fb224f8afa3b87007d58501acfda9215b334eed53072dd5e815ff7a";
        };
        build-system = [ self.setuptools ];
        dependencies = with self; [ filelock fsspec packaging pyyaml requests tqdm typing-extensions hf-xet ];
        doCheck = false;
      };
      tokenizers = if pkgs.stdenv.hostPlatform.system == "x86_64-linux" then self.buildPythonPackage {
        pname = "tokenizers";
        version = "0.22.2";
        format = "wheel";
        src = fetchurl {
          url = "https://files.pythonhosted.org/packages/2e/76/932be4b50ef6ccedf9d3c6639b056a967a86258c6d9200643f01269211ca/tokenizers-0.22.2-cp39-abi3-manylinux_2_17_x86_64.manylinux2014_x86_64.whl";
          sha256 = "369cc9fc8cc10cb24143873a0d95438bb8ee257bb80c71989e3ee290e8d72c67";
        };
        nativeBuildInputs = [ pkgs.autoPatchelfHook ];
        buildInputs = [ pkgs.stdenv.cc.cc.lib ];
        dependencies = [ self.huggingface-hub ];
        doCheck = false;
      } else super.tokenizers;
      transformers = self.buildPythonPackage {
        pname = "transformers";
        version = "4.57.6";
        pyproject = true;
        src = fetchurl {
          url = "https://files.pythonhosted.org/packages/c4/35/67252acc1b929dc88b6602e8c4a982e64f31e733b804c14bc24b47da35e6/transformers-4.57.6.tar.gz";
          sha256 = "55e44126ece9dc0a291521b7e5492b572e6ef2766338a610b9ab5afbb70689d3";
        };
        build-system = [ self.setuptools ];
        dependencies = with self; [ filelock huggingface-hub numpy packaging pyyaml regex requests safetensors tokenizers tqdm ];
        doCheck = false;
      };
      sentence-transformers = self.buildPythonPackage {
        pname = "sentence_transformers";
        version = "5.1.2";
        pyproject = true;
        src = fetchurl {
          url = "https://files.pythonhosted.org/packages/0f/96/f3f3409179d14dbfdbea8622e2e9eaa3c8836ddcaecd2cd5ff0a11731d20/sentence_transformers-5.1.2.tar.gz";
          sha256 = "0f6c8bd916a78dc65b366feb8d22fd885efdb37432e7630020d113233af2b856";
        };
        build-system = [ self.setuptools ];
        dependencies = with self; [ transformers tqdm torch scikit-learn scipy huggingface-hub pillow typing-extensions ];
        doCheck = false;
      };
      omar-rq = self.buildPythonPackage {
        pname = "omar-rq";
        version = "0.2.1";
        pyproject = true;
        src = fetchzip {
          extension = "tar.gz";
          url = "https://codeload.github.com/MTG/omar-rq/tar.gz/985d6513bfeb308f1e0e66de9a7420648a0ff072";
          hash = "sha256-EtynadpBl/4Ak/EEeHISG9pi2VxdXT4NACKPzTsYskE=";
        };
        build-system = [ self.setuptools ];
        dependencies = with self; [ lightning pytorch-lightning torch torchaudio gin-config einops transformers ];
        doCheck = false;
      };
      amclap = self.buildPythonPackage {
        pname = "amclap";
        version = "0.1.0";
        pyproject = true;
        src = fetchzip {
          extension = "tar.gz";
          url = "https://codeload.github.com/MTG/allmusiccaps/tar.gz/602ad59bfe7c11374ea0e9a57aa349d6a8ed3de0";
          hash = "sha256-ioJWUW60mO+Lzi00UOGE5y7Fatw3RoeyLAMHubUOIy0=";
        };
        build-system = [ self.setuptools ];
        dependencies = with self; [ lightning torch torchaudio gin-config einops transformers sentence-transformers omar-rq huggingface-hub ];
        doCheck = false;
      };
      beets-embed-core = self.buildPythonPackage {
        pname = "beets-embed";
        version = "0.1.0";
        pyproject = true;
        src = lib.fileset.toSource {
          root = ./.;
          fileset = lib.fileset.unions [ ./beets_embed ./pyproject.toml ./LICENSE ];
        };
        build-system = [ self.setuptools ];
        pythonRemoveDeps = [ "beets" ];
        pythonImportsCheck = [ "beets_embed.store" ];
        doCheck = false;
      };
    };
  };
  runtime = python.withPackages (ps: with ps; [ beets-embed-core amclap onnxruntime numpy scipy ]);
in
pkgs.writeShellScriptBin (if rocmSupport then "beets-embed-worker-rocm" else "beets-embed-worker") ''
  unset PYTHONPATH PYTHONHOME
  export PYTHONNOUSERSITE=1
  export HF_HUB_OFFLINE=1 TRANSFORMERS_OFFLINE=1 TOKENIZERS_PARALLELISM=false
  export OMP_NUM_THREADS=2 OPENBLAS_NUM_THREADS=2
  export BEETS_EMBED_MODELS=${models}
  export BEETS_EMBED_FFMPEG=${pkgs.ffmpeg}/bin/ffmpeg
  ${lib.optionalString rocmSupport "export BEETS_EMBED_BACKEND=rocm"}
  exec ${runtime}/bin/python -s -m beets_embed.worker "$@"
''
