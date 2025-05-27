import unittest

from beetsplug.userrating import Mp3MediaMonkeyScaler


class MediaMonkeyScalerTest(unittest.TestCase):
    #0.5=26, 1=51, 1.5=76, 2=102, 2.5=128, 3=153, 3.5=178, 4=204, 4.5=230, 5=255

    def test_media_monkey_scale_rating(self):
        scaler = Mp3MediaMonkeyScaler()
        #wmp mapping
        self.assertEqual(0, scaler.scale(0))
        # non compliant: elf.assertEqual(2, scaler.scale(1))
        # non compliant: self.assertEqual(4, scaler.scale(64))
        # non compliant: self.assertEqual(6, scaler.scale(128))
        self.assertEqual(8, scaler.scale(192))
        self.assertEqual(8, scaler.scale(196))
        self.assertEqual(10, scaler.scale(255))
        # specific media monkey values
        self.assertEqual(0, scaler.scale(0))
        self.assertEqual(1, scaler.scale(26))
        self.assertEqual(2, scaler.scale(51))
        self.assertEqual(3, scaler.scale(76))
        self.assertEqual(4, scaler.scale(102))
        self.assertEqual(5, scaler.scale(128))
        self.assertEqual(6, scaler.scale(153))
        self.assertEqual(7, scaler.scale(178))
        self.assertEqual(8, scaler.scale(204))
        self.assertEqual(9, scaler.scale(230))
        self.assertEqual(10, scaler.scale(255))

    def test_media_monkey_unscale_rating(self):
        scaler = Mp3MediaMonkeyScaler()
        self.assertEqual(0, scaler.unscale(0))
        self.assertEqual(26, scaler.unscale(1))
        self.assertEqual(51, scaler.unscale(2))
        self.assertEqual(76, scaler.unscale(3))
        self.assertEqual(102, scaler.unscale(4))
        self.assertEqual(128, scaler.unscale(5))
        self.assertEqual(153, scaler.unscale(6))
        self.assertEqual(178, scaler.unscale(7))
        self.assertEqual(204, scaler.unscale(8))
        self.assertEqual(230, scaler.unscale(9))
        self.assertEqual(255, scaler.unscale(10))
