

# Plugin de Seminar para Quarto

Basado en [Seminar](https://github.com/rajgoel/reveal.js-plugins/tree/master/seminar)

- El plugin de Seminar permite a los usuarios controlar la presentación para otros usuarios que abran la misma presentación al conectarla a un servidor socket.io

- El plugin funciona muy bien de forma nativa en `revealjs`; sin embargo, en quarto el plugin debe utilizar un script de postprocesamiento, de lo contrario no funcionará

## Encabezado YAML

- El `yaml` en quarto actualmente no puede llamar a funciones de otro código `javascript`. Todo el `yaml` parece renderizarse con comillas (pero esto es por diseño de un `yaml`)

- El script `postprocess.py` realiza una búsqueda y reemplazo de las palabras en `yaml` que necesitan ser cambiadas.

## Quarto dificulta colocar `js` personalizado en lugares específicos

- Esto intrínsecamente limita cierta usabilidad; sin embargo, nuevamente, es por diseño para evitar que la renderización de los documentos de quarto se rompa por completo

- Sin embargo, esto significa que las personalizaciones pueden ser difíciles de lograr (como el plugin [Seminar](https://github.com/rajgoel/reveal.js-plugins/tree/master/seminar)) sin un script de postprocesamiento

## Pasos:

1. Un ejemplo de `yaml` para usar seminar

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

- Aquí, `foobar` se reemplaza para llamar a la función `getSeminarMenu()`

2. `quarto render`

(Si no se utiliza el archivo `_quarto.yml`, entonces manualmente después de `quarto render`:

3. ejecutar `uv run postprocess.py`

---

No cambies `foobar` (ubicado dentro de `index.qmd`) ni `barfoo` (ubicado dentro de `./seminar/plugin.yml`); estos son necesarios para inyectar algún `html` y/o `javascript` personalizado más adelante durante el postprocesamiento.

---

- El usuario puede editar los campos 

1. server 

2. room y 

3. hash en el archivo `./seminar/plugin.yml` 

[plugin.yml](https://github.com/adam-coates/seminar-quarto/blob/master/seminar/plugin.yml). Estos deben cambiarse para que funcione con tu servidor `socket.io`. [Un ejemplo de servidor socket.io](https://github.com/rajgoel/seminar)
