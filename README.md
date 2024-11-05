# Seminar plugin for Quarto

Based off [Seminar](https://github.com/rajgoel/reveal.js-plugins/tree/master/seminar)

- Seminar plugin allows users to control the presentation for other users who open the same presentation by connecting the presentation to a socket.io server

- The plugin works great natively in `revealjs` however, in quarto the plugin must involve a postprocessing script otherwise it will not work

## YAML header

- The `yaml` in quarto cannot currently call functions to other `javascript` code. All `yaml` seems to get rendered with quotations (but this is by design of a `yaml`)

- The `postprocess.py` carries out a search and replace for the `yaml` words that need to be changed.

## Quarto makes it hard to put custom `js` in specific places

- This inherently stops some usability, however again this is by design to prevent the rendering of quarto documents from breaking entirely

- This however means that custom things can be hard to accomplish (like the [Seminar](https://github.com/rajgoel/reveal.js-plugins/tree/master/seminar) plugin) without a postprocessing script

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

---

Do not change `foobar` and `barfoo` (located inside `./seminar/plugin.yml`) these are necessary to inject some custom `html` and/or `javascript` later during the postprocessing.

---

- The user can edit the fields 1. server 2. room and 3. hash in the file `./seminar/plugin.yml` [plugin.yml](https://github.com/adam-coates/seminar-quarto/blob/master/seminar/plugin.yml). These should be changed so that it works with your `socket.io` server. [An example socket.io server](https://github.com/rajgoel/seminar)
