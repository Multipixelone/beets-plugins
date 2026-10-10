"""Configure Torch before model construction or parallel tensor work."""

_interop_configured = False


def configure_torch_threads(threads):
    import torch
    global _interop_configured
    if not _interop_configured:
        # The setter may only run once. Cooperate with callers that already
        # selected one thread, but never hide an incompatible late setup.
        if torch.get_num_interop_threads() != 1:
            torch.set_num_interop_threads(1)
        _interop_configured = True
    torch.set_num_threads(threads)
