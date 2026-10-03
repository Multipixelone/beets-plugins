{ lib, fetchzip }:
fetchzip {
  name = "essentia-svm-models-2.1_beta5";
  url = "https://essentia.upf.edu/svm_models/essentia-extractor-svm_models-v2.1_beta5.tar.gz";
  hash = "sha256-xLx0LUwpTlTzKgbfemBDgSKQgtESzk1zooQuBAkN+oY=";
  # These histories must match the beta5 extractor.
  meta = {
    description = "Pre-trained beta5 SVM models for Essentia high-level descriptors";
    homepage = "https://essentia.upf.edu/svm_models/";
    license = lib.licenses.cc-by-nc-sa-40;
    maintainers = with lib.maintainers; [ Multipixelone ];
  };
}
