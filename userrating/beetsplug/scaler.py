class Scaler(object):
    """
    this class is to scale a value from/to a specific player
    to/from a value usable for the rating which range is 0-10
    """
    MAX_ACCEPTED_VALUE = 10

    def __init__(self, name, max_value=255):
        self.name = name
        self.max_value = max_value

    def scale(self, popm_value):
        """
        scale a raw value stored by another player to internal value (0-10)
        raw value range depends on player and media type.

        :param popm_value: raw value read
        :return: a value scaled to be between 0-10
        """
        return round(popm_value / self.max_value * Scaler.MAX_ACCEPTED_VALUE)

    def unscale(self, userrating_value):
        """
        scale a internal value to a value understandable by the player.

        :param userrating_value: a value between 0-10
        :return: a value scaled for the player
        """
        return round(userrating_value * self.max_value / Scaler.MAX_ACCEPTED_VALUE)

    # ratings is a dict key = player/user, value = rating
    # result is the key it can scale.
    def known(self, ratings):
        for key in ratings.keys():
            if self.name in key:
                return self.name
        return None


class Mp3QuodlibetScaler(Scaler):
    def __init__(self):
        super(Mp3QuodlibetScaler, self).__init__('quodlibet@lists.sacredchao.net')


class Mp3WinampScaler(Scaler):
    def __init__(self):
        super(Mp3WinampScaler, self).__init__('rating@winamp.com')


class Mp3BeetsScaler(Scaler):
    def __init__(self):
        super(Mp3BeetsScaler, self).__init__('rating@beets.io')
