import unittest

import six

from test.helper import TestHelper


class UserRatingsPluginImportTest(TestHelper, unittest.TestCase):

    def setUp(self):
        self.setup_beets()

        try:
            self.load_plugins('userrating')
        except Exception:
            import sys
            # store exception info so an error in teardown does not swallow it
            exc_info = sys.exc_info()
            try:
                self.teardown_beets()
                self.unload_plugins()
            except Exception:
                # if load_plugins() failed then setup is incomplete and
                # teardown operations may fail. In particular # {Item,Album}
                # may not have the _original_types attribute in unload_plugins
                pass
            six.reraise(exc_info[1], None, exc_info[2])

        self.album_mp3 = self.add_album_fixture(1, ext='mp3', filename='full-with-wmp-rating')
        for item in self.album_mp3.items():
            self._reset_userrating(item)

        self.album_wma = self.add_album_fixture(1, ext='wma', filename='full-with-wmp-rating')
        for item in self.album_wma.items():
            self._reset_userrating(item)

        self.album_flac = self.add_album_fixture(1, ext='flac', filename='full-with-wmp-rating')
        for item in self.album_flac.items():
            self._reset_userrating(item)

    def tearDown(self):
        self.teardown_beets()
        self.unload_plugins()

    @staticmethod
    def _reset_userrating(item, value=None):
        item['userrating'] = value
        item.write()
        item.store()

    def test_cli_rating_list_with_unimported_rating(self):
        for item in self.lib.items():
            if item.path.decode().endswith('mp3'):  # until I found how a FLAC and WMA rated file...
                self.assertNotIn('userrating', item, '%s is not rated' % item.path)
                self.assertIn('externalrating', item, '%s is externally rated' % item.path)
        self.run_with_output('userrating')
        for item in self.lib.items():
            if item.path.decode().endswith('mp3'):  # until I found how a FLAC and WMA rated file...
                self.assertNotIn('userrating', item, '%s is not rated' % item.path)

    # check behavior of rating item in all known cases:
    # - unrated,
    # - rated without overwrite
    # - rated with overwrite
    def test_cli_rating_import_with_wmp_rating(self):
        # check the items are not rating at first
        for item in self.lib.items():
            if item.path.decode().endswith('mp3'):  # until I found how a FLAC and WMA rated file...
                self.assertNotIn('userrating', item, '%s is not rated' % item.path)
                self.assertIn('externalrating', item, '%s is externally rated' % item.path)
        # rate the items with value '1'
        self.run_with_output('userrating', '-i')
        for item in self.lib.items():
            if item.path.decode().endswith('mp3'):  # until I found how a FLAC and WMA rated file...
                self.assertIn('userrating', item, '%s is rated' % item.path)
                self.assertEqual(8, item.userrating)
