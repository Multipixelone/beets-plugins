import unittest

from beetsplug.userrating import Mp3WindowsMediaPlayerScaler


class WindowsMediaPlayerScalerTest(unittest.TestCase):

    def test_windows_media_player_scale_rating(self):
        scaler = Mp3WindowsMediaPlayerScaler()
        #wmp mapping
        self.assertEqual(0, scaler.scale(0))
        self.assertEqual(2, scaler.scale(1))
        self.assertEqual(4, scaler.scale(64))
        self.assertEqual(6, scaler.scale(128))
        self.assertEqual(8, scaler.scale(192))
        self.assertEqual(8, scaler.scale(196))
        self.assertEqual(10, scaler.scale(255))


    def test_window_smedia_player_unscale_rating(self):
        scaler = Mp3WindowsMediaPlayerScaler()
        self.assertEqual(0, scaler.unscale(0))
        self.assertEqual(0, scaler.unscale(1))
        self.assertEqual(1, scaler.unscale(2))
        self.assertEqual(1, scaler.unscale(3))
        self.assertEqual(64, scaler.unscale(4))
        self.assertEqual(64, scaler.unscale(5))
        self.assertEqual(128, scaler.unscale(6))
        self.assertEqual(128, scaler.unscale(7))
        self.assertEqual(196, scaler.unscale(8))
        self.assertEqual(196, scaler.unscale(9))
        self.assertEqual(255, scaler.unscale(10))
