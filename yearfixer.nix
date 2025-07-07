{
  lib,
  beets,
  pythonPackages,
}:
pythonPackages.buildPythonApplication rec {
  pname = "beets-yearfixer";
  pyproject = true;
  build-system = [
    pythonPackages.setuptools
  ];
  version = "0.0.5";

  src = pythonPackages.fetchPypi {
    pname = "beets_yearfixer";
    inherit version;
    sha256 = "sha256-4IuwrgmbK94dna0IaA5M+YIOrD/mqXlPKZ52yeg8WsU=";
  };

  nativeBuildInputs = [
    beets
  ];

  propagatedBuildInputs = [
    pythonPackages.requests
  ];

  meta = with lib; {
    description = "A beets plugin to add low and high level musical information to songs.";
    homepage = "https://github.com/adamjakab/BeetsPluginXtractor";
    maintainers = with maintainers; [johnhamelink];
    license = licenses.mit;
  };
}
