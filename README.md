# Seminar plugin for Quarto

Based off [Seminar](https://github.com/rajgoel/reveal.js-plugins/tree/master/seminar)

- Seminar plugin allows users to control the presentation for other users who open the same presentation by connecting the presentation to a socket.io server

- The plugin works great natively in `revealjs` however, in quarto the plugin must involve a postprocessing script otherwise it will not work

## YAML header

- The `yaml` in quarto cannot currently call functions to other `javascript` code. All `yaml` seems to get rendered with quotations (but this is by design of a `yaml`)

- The `postprocess.py` carries out a search and replace for the `yaml` words that need to be changed.

## Quarto makes it hard to put custom `js` in specific places

- This inherently stops some usability, however again this is by design to prevent the quarto rendering scripts from breaking entirely

- This however means that extremely custom things can be hard without a postprocessing script

## Steps:

1. An example `yaml` for using seminar

```yaml
title: Quarto and seminar plugin
format:
  revealjs:
    self-contained: true
    revealjs-plugins:
      - seminar
    include-after-body: custom.js
    menu:
      themes: false
      transitions: false
      markers: true
      hideMissingTitles: true
      custom:
        - title: "Broadcast"
          icon: '<i class="fas fa-rss"></i>'
          content: foobar
```

- Here foobar is replaced to call the function `getSeminarMenu()`

2. `quarto render`

3. `pip install beautifulsoup4 requests`

4. run `python postprocess.py`
