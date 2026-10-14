"""Initial knobs, not empirically tuned; cluster_threshold is always explicit."""

N = 15
K = 100
STEER_WEIGHT = 0.3
FRESH = False
FRESH_BONUS = 0.1
MAX_PER_ARTIST = 2
POOL_MULTIPLE = 10
SKIP_MIN = 3
LOW_RATING_MAX = 4
LENGTH_MAX_FLOOR = 60.0
LENGTH_SEED_RATIO = 0.8
SINGLETON_MERGE_MIN = 8
HEAD_SUMMARY_LIMIT = 2
ZSCORE_EPSILON = 1e-8
STEERING_MIN_NORM = 1e-12  # Match embed.unit's normalization floor.
DIMENSIONS = {"style": 1280, "text": 512}
