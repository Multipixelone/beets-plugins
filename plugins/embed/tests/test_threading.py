import unittest
from types import SimpleNamespace
from unittest.mock import Mock, patch

from beets_embed.inference import Models, onnx_options


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


if __name__ == "__main__":
    unittest.main()
