import unittest

from beetsplug.userrating import Mp3BansheeScaler


class BansheeScalerTest(unittest.TestCase):

    # unrated=0, 2=1-63, 4=64-127, 6=128-191, 8=192-254, 10=255
    def test_banshee_scale_rating(self):
        scaler = Mp3BansheeScaler()
        #wmp mapping
        self.assertEqual(0, scaler.scale(0))
        self.assertEqual(2, scaler.scale(1))
        self.assertEqual(4, scaler.scale(64))
        self.assertEqual(6, scaler.scale(128))
        self.assertEqual(8, scaler.scale(192))
        self.assertEqual(8, scaler.scale(196))
        self.assertEqual(10, scaler.scale(255))
        #specific values mapping
        self.assertEqual(4, scaler.scale(127))
        self.assertEqual(6, scaler.scale(128))
        self.assertEqual(6, scaler.scale(191))
        self.assertEqual(8, scaler.scale(254))

    def test_banshee_unscale_rating(self):
        scaler = Mp3BansheeScaler()
        self.assertEqual(0, scaler.unscale(0))
        self.assertEqual(0, scaler.unscale(1))
        self.assertEqual(1, scaler.unscale(2))
        self.assertEqual(1, scaler.unscale(3))
        self.assertEqual(64, scaler.unscale(4))
        self.assertEqual(64, scaler.unscale(5))
        self.assertEqual(128, scaler.unscale(6))
        self.assertEqual(128, scaler.unscale(7))
        self.assertEqual(192, scaler.unscale(8))
        self.assertEqual(192, scaler.unscale(9))
        self.assertEqual(255, scaler.unscale(10))
