from beetsplug.scaler import Scaler


class Mp3BansheeScaler(Scaler):
    """
    scaler to be able to maage Banshee rating

    source: https://gitlab.gnome.org/GNOME/banshee/blob/master/src/Core/Banshee.Core/Banshee.Streaming/StreamRatingTagger.cs#L66-67
    """

    def __init__(self):
        super(Mp3BansheeScaler, self).__init__('Banshee')

    def scale(self, popm_value):
        if popm_value <= 0:
            return 0
        if popm_value < 64:
            return 2
        if popm_value < 128:
            return 4
        if popm_value < 192:
            return 6
        if popm_value < 255:
            return 8
        return 10

    def unscale(self, userrating_value):
        if userrating_value <= 1:
            return 0
        if userrating_value <= 3:
            return 1
        if userrating_value <= 5:
            return 64
        if userrating_value <= 7:
            return 128
        if userrating_value < 10:
            return 192
        if userrating_value == 10:
            return 255
        return 0
