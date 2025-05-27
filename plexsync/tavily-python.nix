{
  lib,
  pythonPackages,
  fetchPypi,
}:
pythonPackages.buildPythonPackage rec {
  pname = "tavily-python";
  version = "0.4.0";
  pyproject = true;

  src = fetchPypi {
    pname = "tavily_python";
    inherit version;
    hash = "sha256-5FFwQd0TXxcYWNfmWnyuCFWXhxu9waE9J5kKy1NuVcM=";
  };

  build-system = with pythonPackages; [
    setuptools
    wheel
  ];

  dependencies = with pythonPackages; [
    httpx
    requests
    tiktoken
  ];

  pythonImportsCheck = [
    "tavily"
  ];

  meta = {
    description = "Python wrapper for the Tavily API";
    homepage = "https://pypi.org/project/tavily-python";
    license = lib.licenses.mit;
    maintainers = with lib.maintainers; [happysalada];
  };
}
