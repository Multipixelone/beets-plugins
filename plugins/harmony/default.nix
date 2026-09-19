{
  lib,
  beets,
  pythonPackages,
}:
pythonPackages.buildPythonPackage {
  pname = "beets-harmony";
  version = "0.1.0";
  pyproject = true;

  src = ./.;

  build-system = [
    pythonPackages.setuptools
  ];

  dependencies = [
    pythonPackages.requests
    pythonPackages.segno
  ];

  # The combined package already is the beets derivation. Propagating the
  # build-time beets here would add a second copy to the Python closure.
  pythonRemoveDeps = [
    "beets"
  ];

  nativeCheckInputs = [
    beets
    pythonPackages.requests
    pythonPackages.segno
  ];

  pythonImportsCheck = [
    "beetsplug.harmony"
  ];

  preCheck = ''
    export HOME="$TMPDIR/home"
    export XDG_CONFIG_HOME="$TMPDIR/xdg-config"
    mkdir -p "$HOME" "$XDG_CONFIG_HOME"
  '';

  checkPhase = ''
    runHook preCheck
    PYTHONPATH="$PWD:$PYTHONPATH" ${pythonPackages.python.interpreter} -m unittest discover -s tests -p 'test_*.py' -v
    runHook postCheck
  '';

  meta = {
    description = "Interactive, fail-open Harmony assistance for beets imports";
    license = lib.licenses.gpl3Only;
    maintainers = with lib.maintainers; [
      Multipixelone
    ];
  };
}
