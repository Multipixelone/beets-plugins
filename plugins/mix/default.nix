{ lib, beets, pythonPackages, embed, worker }:
pythonPackages.buildPythonPackage {
  pname = "beets-mix";
  version = "0.1.0";
  pyproject = true;
  src = lib.fileset.toSource {
    root = ./.;
    fileset = lib.fileset.unions [ ./beetsplug ./beets_mix ./tests ./pyproject.toml ./LICENSE ];
  };
  build-system = [ pythonPackages.setuptools ];
  # The final bundle already is beets; retain the base package only for checks.
  pythonRemoveDeps = [ "beets" ];
  dependencies = [ pythonPackages.numpy embed pythonPackages.plexapi pythonPackages.requests ];
  postPatch = ''
    substituteInPlace beetsplug/mix/__init__.py \
      --replace-fail '@embed-worker@' '${worker}/bin/beets-embed-worker'
  '';
  doCheck = true;
  nativeCheckInputs = [ beets ];
  pythonImportsCheck = [ "beets_mix" "beetsplug.mix" ];
  preCheck = ''
    export HOME="$TMPDIR/home" XDG_CONFIG_HOME="$TMPDIR/xdg-config"
    export XDG_CACHE_HOME="$TMPDIR/xdg-cache" XDG_DATA_HOME="$TMPDIR/xdg-data"
    export XDG_STATE_HOME="$TMPDIR/xdg-state" XDG_RUNTIME_DIR="$TMPDIR/xdg-runtime"
    export BEETSDIR="$XDG_CONFIG_HOME/beets"
    export PYTHONDONTWRITEBYTECODE=1 PYTHONNOUSERSITE=1
    export HF_HUB_OFFLINE=1 TRANSFORMERS_OFFLINE=1 HF_DATASETS_OFFLINE=1
    export OPENBLAS_NUM_THREADS=1 OMP_NUM_THREADS=1
    mkdir -p "$HOME" "$XDG_CONFIG_HOME" "$XDG_CACHE_HOME" "$XDG_DATA_HOME" \
      "$XDG_STATE_HOME" "$XDG_RUNTIME_DIR" "$BEETSDIR"
    chmod 700 "$XDG_RUNTIME_DIR"
  '';
  checkPhase = ''
    runHook preCheck
    PYTHONPATH="$PWD:$PWD/tests:$PYTHONPATH" ${pythonPackages.python.interpreter} -m unittest discover -s tests -p 'test_*.py' -v
    runHook postCheck
  '';
  meta = {
    description = "Stateless music mix proposals and explicitly approved playlist appends for beets";
    license = lib.licenses.agpl3Plus;
    maintainers = with lib.maintainers; [ Multipixelone ];
    platforms = [ "x86_64-linux" ];
  };
}
