{
  lib,
  beets,
  pythonPackages,
}:
pythonPackages.buildPythonApplication rec {
  pname = "beets-autofix";
  version = "0.1.6";

  src = pythonPackages.fetchPypi {
    pname = "beets_autofix";
    inherit version;
    sha256 = "sha256-vD/WAngt/uBlUuaNsvENdognrSxnChSekmyA8SR/fYE=";
  };

  nativeBuildInputs = [
    beets
    pythonPackages.alive-progress
  ];

  propagatedBuildInputs = [
  ];

  meta = with lib; {
    description = "A beets plugin to add low and high level musical information to songs.";
    homepage = "https://github.com/adamjakab/BeetsPluginXtractor";
    maintainers = with maintainers; [johnhamelink];
    license = licenses.mit;
  };
}
