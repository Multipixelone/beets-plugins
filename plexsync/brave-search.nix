{
  lib,
  pythonPackages,
  fetchFromGitHub,
}:
pythonPackages.buildPythonPackage rec {
  pname = "brave_search";
  version = "0.2.0";
  pyproject = true;

  # src = pythonPackages.fetchPypi {
  #   inherit pname version;
  #   sha256 = "sha256-TdAuEudhv71QwZh9EJFCoNsuH6LSO0JLgW8RP5dt0wk=";
  # };
  src = fetchFromGitHub {
    owner = "kayvane1";
    repo = "brave-api";
    tag = "v.${version}";
    sha256 = "sha256-/xL8Hl0rTSIxUCEY9thY54zuOw4hHq2yDo4bVYVRnvM=";
  };

  build-system = with pythonPackages; [
    # setuptools
    poetry-core
  ];

  dependencies = with pythonPackages; [
    requests
    httpx
    tenacity
    pydantic
    pytest-asyncio
    numpy
  ];

  # like. this is such a hack LMFAOOOO. the version u want is the one I have <3
  postPatch = ''
    substituteInPlace pyproject.toml --replace-fail "httpx = \">=0.24.0, <0.26.0\"" "httpx = \"${pythonPackages.httpx.version}\""
    substituteInPlace pyproject.toml --replace-fail "numpy = \"^1.24.4\"" "numpy = \"${pythonPackages.numpy.version}\""
    substituteInPlace pyproject.toml --replace-fail "tenacity = \"^8.2.3\"" "tenacity = \"${pythonPackages.tenacity.version}\""
    substituteInPlace pyproject.toml --replace-fail "pytest-asyncio = \"^0.23.2\"" "pytest-asyncio = \"${pythonPackages.pytest-asyncio.version}\""
  '';

  meta = {
    description = "brave-search api in python";
    homepage = "https://brave.com/search/api/";
    license = lib.licenses.mit;
  };
}
