{
  lib,
  beets,
  python3Packages,
  pythonPackages,
  fetchFromGitHub,
  version,
}:
python3Packages.buildPythonApplication {
  inherit version;
  pname = "beets-plexsync";
  pyproject = true;
  doCheck = false;
  pytestCheckHook = false;

  src = fetchFromGitHub {
    owner = "arsaboo";
    repo = "beets-plexsync";
    rev = "1c618ae78a4951255f414bd77afdf4ad01901d90";
    hash = "sha256-LTXUO5ARwf3JkpDa+IZW3cZ8x2onmMcJzIo+P3E893U=";
  };

  nativeBuildInputs = [
    beets
  ];

  build-system = with pythonPackages; [
    setuptools
  ];

  dependencies = with pythonPackages; [
    plexapi
    spotipy
    enlighten
    openai
    pydantic
    dateutil
    confuse
    requests
    beautifulsoup4
    pillow
    json-repair

    (pkgs.callPackage ./jiosaavn-python.nix {inherit pythonPackages;})
    # (pkgs.callPackages ./agno.nix {inherit pythonPackages;})
    (pkgs.callPackages ./tavily-python.nix {inherit pythonPackages;})
    # (pkgs.callPackages ./exa-py.nix {inherit pythonPackages;})
  ];

  postPatch = ''
    sed -i -e '/agno/d' setup.py
    sed -i -e '/tavily-python/d' setup.py
    sed -i -e '/exa_py/d' setup.py
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
