{ lib, beets, pythonPackages, worker, viewer }:
pythonPackages.buildPythonPackage {
  pname = "beets-embed";
  version = "0.1.0";
  pyproject = true;
  src = lib.fileset.toSource {
    root = ./.;
    fileset = lib.fileset.unions [ ./beetsplug ./beets_embed ./tests ./pyproject.toml ./LICENSE ];
  };
  build-system = [ pythonPackages.setuptools ];
  pythonRemoveDeps = [ "beets" ];
  dependencies = [ pythonPackages.numpy ];
  postPatch = ''
    substituteInPlace beetsplug/embed/__init__.py \
      --replace-fail '@embed-worker@' '${worker}/bin/beets-embed-worker' \
      --replace-fail '@album-graph-viewer@' '${viewer}/bin/beets-album-graph'
  '';
  nativeCheckInputs = [ beets pythonPackages.numpy pythonPackages.scipy ];
  pythonImportsCheck = [ "beetsplug.embed" ];
  preCheck = ''
    export HOME="$TMPDIR/home" XDG_CONFIG_HOME="$TMPDIR/xdg-config"
    mkdir -p "$HOME" "$XDG_CONFIG_HOME"
  '';
  checkPhase = ''
    runHook preCheck
    PYTHONPATH="$PWD:$PYTHONPATH" ${pythonPackages.python.interpreter} -m unittest discover -s tests -v
    runHook postCheck
  '';
  meta = {
    description = "Offline neural music similarity and audio-text search for beets";
    license = lib.licenses.agpl3Plus;
    maintainers = with lib.maintainers; [ Multipixelone ];
    platforms = [ "x86_64-linux" ];
  };
}
