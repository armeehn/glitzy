"""Glitzy engine, v2.

    source -> [ops] -> clip

Every node's output is cached under a hash of the whole chain prefix that
produced it, which is what makes the studio a place to experiment rather than
a button that cooks one thing.
"""

VERSION = "2.0"
