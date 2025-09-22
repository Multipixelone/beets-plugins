{
  lib,
  beets,
  python3Packages,
  pythonPackages,
  pins,
}:
python3Packages.buildPythonApplication rec {
  version = pins.beets-stylize.revision;
  pname = "beets-stylize";

  pyproject = true;
  doCheck = false;
  pytestCheckHook = false;

  src = pins.beets-stylize;

  nativeBuildInputs = [
    beets
  ];

  build-system = with pythonPackages; [
    setuptools
    poetry-core
  ];

  dependencies = with pythonPackages; [
    click
  ];

  # postPatch = ''
  #   printf 'from pkgutil import extend_path\n__path__ = extend_path(__path__, __name__)\n' >__init__.py
  # '';

  # preBuild = ''
  #   mkdir beetsplug
  #   cp __init__.py stylize.py beetsplug/
  #       cat > setup.py << EOF
  #   from setuptools import setup

  #   setup(
  #     name='${pname}',
  #     version='1.0',

  #     packages=['beetsplug'],
  #     install_requires=['beets>=1.3.11'],
  #   )
  #   EOF
  # '';
  meta = {
    description = "Beets plugin to manage external files";
    maintainers = with lib.maintainers; [
      Multipixelone
    ];
    license = lib.licenses.mit;
  };
}
