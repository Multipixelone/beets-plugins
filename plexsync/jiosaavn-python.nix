{
  lib,
  fetchFromGitHub,
  python3Packages,
  pythonPackages,
}:
python3Packages.buildPythonPackage rec {
  version = "0.2";
  pname = "jiosaavn-python";
  pyproject = true;
  doCheck = false;
  pytestCheckHook = false;

  src = fetchFromGitHub {
    repo = "jiosaavn-python";
    owner = "abhichaudharii";
    rev = "v${version}";
    hash = "sha256-TmMdoo7zpEdeuWoMguke4ngaTkNuvM9Wa08hwtjL2iI=";
  };

  # nativeBuildInputs = [
  #   beets
  # ];

  build-system = with pythonPackages; [
    setuptools
  ];

  dependencies = with pythonPackages; [
    httpx
  ];

  meta = {
    description = "Python package to interface with jiosaavn";
    maintainers = with lib.maintainers; [
      Multipixelone
    ];
    license = lib.licenses.mit;
  };
}
