{
  lib,
  pythonPackages,
}:
pythonPackages.buildPythonPackage rec {
  pname = "exa_py";
  version = "1.13.1";
  pyproject = true;

  src = pythonPackages.fetchPypi {
    inherit pname version;
    sha256 = "sha256-wejugqRYpzRBAik+D6Jyqjs5ppgRXpBY+Z3adqocJ0c=";
  };

  build-system = with pythonPackages; [
    setuptools
    poetry-core
  ];

  dependencies = with pythonPackages; [
    requests
    typing-extensions
    openai
    pytest-mock
  ];

  meta = {
    description = "Exa (formerly metaphor) API in python";
    homepage = "https://agno.com";
    license = lib.licenses.mpl20;
  };
}
