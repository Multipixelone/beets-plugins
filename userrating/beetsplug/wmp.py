from beetsplug.scaler import Scaler


class Mp3WindowsMediaPlayerScaler(Scaler):
    """
    windows media player 9, 10, 11, 12 compliant scaler
    0 → POPM=0
    1 → POPM=1
    2 → POPM=64
    3 → POPM=128
    4 → POPM=196
    5 → POPM=255
    """
    _rating_table = [0, 0, 1, 1, 64, 64, 128, 128, 196, 196, 255]

    def __init__(self):
        super(Mp3WindowsMediaPlayerScaler, self).__init__('Windows Media Player 9 Series')

    def scale(self, popm_value):
        try:
            return self._rating_table.index(popm_value)
        except ValueError:
            return super(Mp3WindowsMediaPlayerScaler, self).scale(popm_value)

    def unscale(self, userrating_value):
        try:
            return self._rating_table[userrating_value]
        except ValueError:
            return super(Mp3WindowsMediaPlayerScaler, self).unscale(userrating_value)

