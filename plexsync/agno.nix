{
  lib,
  pythonPackages,
}:
pythonPackages.buildPythonPackage rec {
  pname = "agno";
  version = "2.3.20";
  pyproject = true;

  src = pythonPackages.fetchPypi {
    inherit pname version;
    sha256 = "sha256-E/zth3F9qF4A+8T5Vx6C+rOQN208fpJFin4umY3JUMY=";
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
