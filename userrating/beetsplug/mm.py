from beetsplug.scaler import Scaler


class Mp3MediaMonkeyScaler(Scaler):
    """
    scaler to be able to manage MediaMonkey rating

    source : 2012 :  https://gitlab.gnome.org/GNOME/banshee/blob/master/src/Core/Banshee.Core/Banshee.Streaming/StreamRatingTagger.cs#L60-62
    0.5=26, 1=51, 1.5=76, 2=102, 2.5=128, 3=153, 3.5=178, 4=204, 4.5=230, 5=255

    older source (no more taken into account)
    source : 2009 : http://mediamonkey.com/forum/viewtopic.php?f=7&t=40532#p217410
    description of the mapping between POPM -> media monkey 3.1+
    POPM=0 → Rating=0
    POPM=1 → Rating=1
    POPM=2-8 → Rating=0
    POPM=9-18 → Rating=0.5
    POPM=19-28 → Rating=1 (MM2.5:Rating=0.5 → POPM=28) (MM3.0:Rating=0.5 → POPM=26)
    POPM=29 → Rating=1.5
    POPM=30-39 → Rating=0.5
    POPM=40-49 → Rating=1
    POPM=50-59 → Rating=1.5 (MM2.5:Rating=1 → POPM=53) (MM3.0:Rating=1 → POPM=51)
    POPM=60-69 → Rating=2
    POPM=70-90 → Rating=1.5
    POPM=91-113 → Rating=2
    POPM=114-123 → Rating=2.5
    POPM=124-133 → Rating=3 (MM2.5:Rating=2.5 → POPM=129) (MM3.0:Rating=2.5 → POPM=128)
    POPM=134-141 → Rating=2.5
    POPM=142-167 → Rating=3
    POPM=168-191 → Rating=3.5
    POPM=192-218 → Rating=4
    POPM=219-247 → Rating=4.5
    POPM=248-255 → Rating=5
    """

    def __init__(self):
        super(Mp3MediaMonkeyScaler, self).__init__('no@email')

    # def scale(self, popm_value):
    #     if popm_value > 247:#248-255
    #         return 10
    #     if popm_value > 218:#219-247
    #         return 9
    #     if popm_value > 191:#192-218
    #         return 8
    #     if popm_value > 167:#168-191
    #         return 7
    #     if popm_value > 141:#142-167
    #         return 6
    #     if popm_value > 133:#134-141
    #         return 5
    #     if popm_value > 123:#124-133
    #         return 6
    #     if popm_value > 113:#114-123
    #         return 5
    #     if popm_value > 90:#91-113
    #         return 4
    #     if popm_value > 69:#70-90
    #         return 3
    #     if popm_value > 59:#60-69
    #         return 4
    #     if popm_value > 49:#50-59
    #         return 3
    #     if popm_value > 39:#40-49
    #         return 2
    #     if popm_value > 29:#30-39
    #         return 1
    #     if popm_value > 28:#29
    #         return 3
    #     if popm_value > 18:#19-28
    #         return 1
    #     if popm_value > 8:#9-18
    #         return 2
    #     if popm_value > 1:#2-8
    #         return 0
    #     if popm_value > 0:#1
    #         return 2
    #     return 0 #0
    #
    # def unscale(self, userrating_value):
    #     """
    #     Media monkey is using internally a value between 0-100
    #     so we use the same algorithm as media monkey
    #     by using 10 * the internal value which is between 0-10
    #     """
    #     value = userrating_value * 10
    #     if value <= 0:
    #         return 0
    #     if value <= 25:
    #         return value + 3
    #     if value <= 45:
    #         return value + 24
    #     if value <= 65:
    #         return value + 68
    #     if value <= 85:
    #         return value + 116
    #     return value + 152



