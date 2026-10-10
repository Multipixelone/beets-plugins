import unittest
from types import SimpleNamespace
from unittest.mock import Mock, patch

from beets_embed.inference import Models, onnx_options
from beets_embed import threads


class OnnxThreadTests(unittest.TestCase):
    def test_all_production_sessions_block_while_idle(self):
        options = SimpleNamespace(add_session_config_entry=Mock())
        ort = SimpleNamespace(SessionOptions=Mock(return_value=options),
                              ExecutionMode=SimpleNamespace(ORT_SEQUENTIAL="sequential"),
                              InferenceSession=Mock())
        with patch.dict("sys.modules", {"onnxruntime": ort}):
            Models("/assets", threads=4)
        self.assertEqual(options.intra_op_num_threads, 4)
        self.assertEqual(options.inter_op_num_threads, 1)
        self.assertEqual(options.execution_mode, "sequential")
        self.assertEqual(options.add_session_config_entry.call_args_list,
                         [unittest.mock.call("session.intra_op.allow_spinning", "0"),
                          unittest.mock.call("session.inter_op.allow_spinning", "0")])
        self.assertEqual(ort.InferenceSession.call_count, 5)
        for call in ort.InferenceSession.call_args_list:
            self.assertIs(call.args[1], options)
            self.assertEqual(call.kwargs["providers"], ["CPUExecutionProvider"])


class TorchThreadTests(unittest.TestCase):
    def test_interop_precedes_intraop_and_is_only_set_once(self):
        torch = Mock()
        torch.get_num_interop_threads.return_value = 8
        with patch.dict("sys.modules", {"torch": torch}), \
             patch.object(threads, "_interop_configured", False):
            threads.configure_torch_threads(2)
            threads.configure_torch_threads(4)
        self.assertEqual(torch.mock_calls, [unittest.mock.call.get_num_interop_threads(),
                         unittest.mock.call.set_num_interop_threads(1),
                         unittest.mock.call.set_num_threads(2),
                         unittest.mock.call.set_num_threads(4)])

    def test_already_bounded_interop_is_not_reset(self):
        torch = Mock()
        torch.get_num_interop_threads.return_value = 1
        with patch.dict("sys.modules", {"torch": torch}), \
             patch.object(threads, "_interop_configured", False):
            threads.configure_torch_threads(8)
        torch.set_num_interop_threads.assert_not_called()
        torch.set_num_threads.assert_called_once_with(8)

    def test_late_incompatible_configuration_is_not_hidden(self):
        torch = Mock()
        torch.get_num_interop_threads.return_value = 8
        torch.set_num_interop_threads.side_effect = RuntimeError("parallel work started")
        with patch.dict("sys.modules", {"torch": torch}), \
             patch.object(threads, "_interop_configured", False):
            with self.assertRaisesRegex(RuntimeError, "parallel work started"):
                threads.configure_torch_threads(2)
            self.assertFalse(threads._interop_configured)
        torch.set_num_threads.assert_not_called()


if __name__ == "__main__":
    unittest.main()
