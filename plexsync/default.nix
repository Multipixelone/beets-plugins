{
  lib,
  beets,
  beets-plexsync,
  python3Packages,
  pythonPackages,
}:
python3Packages.buildPythonPackage rec {
  pname = "beets-plexsync";
  version = beets-plexsync.rev;
  pyproject = true;
  doCheck = false;
  pytestCheckHook = false;

  src = beets-plexsync;

  patches = [
    ./temperature.patch
  ];

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
    python-dateutil
    confuse
    requests
    beautifulsoup4
    pillow
    json-repair
    instructor
    pytz

    (pkgs.callPackage ./jiosaavn-python.nix { inherit pythonPackages; })
    (pkgs.callPackage ./agno.nix { inherit pythonPackages; })
    (pkgs.callPackage ./tavily-python.nix { inherit pythonPackages; })
    (pkgs.callPackage ./exa-py.nix { inherit pythonPackages; })
    (pkgs.callPackage ./brave-search.nix { inherit pythonPackages; })
  ];

  postPatch = ''
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
