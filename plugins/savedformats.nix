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
  # upstream's real distribution name is "beets-kergoth"; pname here is a
  # deliberate nix-side rename, so the dist-info name will never match.
  dontCheckPythonMetadata = true;

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
    substituteInPlace pyproject.toml --replace-fail "rich = \"^13.7.1\"" "rich=\"${pythonPackages.rich.version}\""

    # Beets 2.13 caches template source strings; retain the Template for its
    # public `original` source when evaluating it rather than passing it in.
    substituteInPlace beetsplug/savedformats.py --replace-fail "functemplate.template(templatestr)" "functemplate.Template(templatestr)"
    substituteInPlace beetsplug/savedformats.py --replace-fail "item.evaluate_template(template)" "item.evaluate_template(template.original)"

    mkdir -p beetsplug
    printf 'from pkgutil import extend_path\n__path__ = extend_path(__path__, __name__)\n' >beetsplug/__init__.py
  '';

  postInstall = ''
    # Exercise the installed plugin against the packaged beets runtime.
    (
      cd "$TMPDIR"
      HOME="$TMPDIR" PYTHONPATH="$out/${pythonPackages.python.sitePackages}:$PYTHONPATH" ${pythonPackages.python.interpreter} - <<'PY'
    from beets import config
    from beets.library import Item
    from beetsplug.savedformats import SavedFormatsPlugin

    config["item_formats"].set({"saved_title": "$title"})
    plugin = SavedFormatsPlugin()
    assert plugin.template_fields["saved_title"](Item(title="Saved title")) == "Saved title"
    PY
    )
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
