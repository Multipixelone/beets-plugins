{
  lib,
  fetchFromGitHub,
  beets,
  pythonPackages,
}:
pythonPackages.buildPythonPackage rec {
  pname = "beets-savedformats";
  version = "776bb16cbb8a161d8ba8651537d172ac9347c4ef";
  pyproject = true;
  doCheck = false;
  pytestCheckHook = false;

  src = fetchFromGitHub {
    repo = "beets-kergoth";
    owner = "kergoth";
    rev = version;
    hash = "sha256-Kv5OzYSORUzMCHtsGgVhqLQPhkdjfwovh4HVOe8TeGs=";
  };

  postPatch = ''
    substituteInPlace pyproject.toml --replace-fail "poetry>=1.0.0b" "poetry-core"
    substituteInPlace pyproject.toml --replace-fail "python = \">=3.8.1,<3.12\"" "python = \">=3.8.1,<3.13\""
    # substituteInPlace pyproject.toml --replace-fail "include = \"beetsplug\"" "include = \"beetsplug\", from = \"src\""
    substituteInPlace pyproject.toml --replace-fail "poetry.masonry.api" "poetry.core.masonry.api"

    # substituteInPlace pyproject.toml --replace-fail "confuse = \"^2.0.1\"" "confuse=\"1.7.0\""
    substituteInPlace pyproject.toml --replace-fail "rich = \"^13.7.1\"" "rich=\"14.1.0\""

    mkdir -p beetsplug
    printf 'from pkgutil import extend_path\n__path__ = extend_path(__path__, __name__)\n' >beetsplug/__init__.py
  '';

  nativeBuildInputs = [
    beets
    pythonPackages.poetry-core
  ];

  build-system = with pythonPackages; [
    setuptools
    poetry-core
  ];

  dependencies = with pythonPackages; [
    confuse
    mediafile
    rich
  ];

  meta = {
    description = "Beets plugin to manage external files";
    maintainers = with lib.maintainers; [
      Multipixelone
    ];
    license = lib.licenses.mit;
  };
}
