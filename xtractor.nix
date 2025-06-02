{
  lib,
  beets,
  pkgs,
  pythonPackages,
}:
pythonPackages.buildPythonApplication rec {
  pname = "beets-xtractor";
  version = "0.4.2";

  src = pythonPackages.fetchPypi {
    pname = "beets_xtractor";
    inherit version;
    sha256 = "sha256-wn25Kewkj0oT+BVnLFuJaLAbZGLkA2eu6bgF1rWTGIk=";
  };

  nativeBuildInputs = [
    beets
  ];

  propagatedBuildInputs = [
    pkgs.essentia-extractor
  ];

  meta = with lib; {
    description = "A beets plugin to add low and high level musical information to songs.";
    homepage = "https://github.com/adamjakab/BeetsPluginXtractor";
    maintainers = with maintainers; [johnhamelink];
    license = licenses.mit;
  };
}
