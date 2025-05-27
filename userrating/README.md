# User rating support for Beets

# https://github.com/jphautin/beets-userrating with my custom changes

The _beet userrating_ plugin reads and manages a `userrating` tag on
your music files.

## Installation

Install package and scripts.

    $ pip install https://github.com/jphautin/beets-userrating/archive/master.zip

Add the plugin to beets configuration file.

```
plugins: (...) userrating
```

## Usage

    beet userrating -h
    Usage: beet userrating [options]
    Options:
     -h, --help   show this help message and exit

## FAQ

### Why not `beet rating`?

It turns out that the `mpdstats` plugin was already maintaining a
`rating` attribute. It seemed easier to just adopt the `userrating`
nomenclature.

### What are the differences with Michael Alan Dorman repository ?

Major changes are:

- added support for WMA
- added a test suite
- add notion of scaler to be able to adapt value for any players
- add an import function (you can import rating on existing item of the library)

### Players supported

Players that are supported when importing ratings :

| Player                  | mp3 | wma | flac |
| ----------------------- | --- | --- | ---- |
| Windows Media Player 9+ | X   |     |      |
| Banshee                 | X   |     |      |
| Media Monkey            | X   |     |      |
| Quod libet              | x   |     |      |
| Winamp                  | x   |     |      |
