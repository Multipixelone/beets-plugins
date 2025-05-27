{
  lib,
  pythonPackages,
}:
pythonPackages.buildPythonPackage rec {
  pname = "agno";
  version = "1.5.5";
  pyproject = true;

  src = pythonPackages.fetchPypi {
    inherit pname version;
    sha256 = "sha256-iTcNstRH6SJTCH1oNktkDsY2GFcLyCYfXltwnDz0uHo=";
  };

  build-system = with pythonPackages; [
    setuptools
  ];

  dependencies = with pythonPackages; [
    docstring-parser
    ollama
    gitpython
    pydantic-settings
    pydantic
    httpx
    python-dotenv
    python-multipart
    pyyaml
    rich
    tomli
    typer
    typing-extensions
  ];

  pythonImportsCheck = [
    "agno"
  ];

  meta = {
    description = "a lightweight, high-performance library for building Agents";
    homepage = "https://agno.com";
    license = lib.licenses.mpl20;
  };
}
