{
  lib,
  beets,
  python3Packages,
  pythonPackages,
  version,
}:
python3Packages.buildPythonApplication rec {
  inherit version;
  pname = "beets-userrating";
  pyproject = true;
  doCheck = false;
  pytestCheckHook = false;

  src = ./.;

  nativeBuildInputs = [
    beets
  ];

  build-system = with pythonPackages; [
    setuptools
  ];

  # dependencies = with pythonPackages; [
  # ];

  postPatch = ''
    sed -i -e '/namespace_packages/d' setup.py
    printf 'from pkgutil import extend_path\n__path__ = extend_path(__path__, __name__)\n' >beetsplug/__init__.py
  '';

  meta = {
    description = "Beets plugin to manage external files";
    maintainers = with lib.maintainers; [
      Multipixelone
    ];
    license = lib.licenses.mit;
  };
}
