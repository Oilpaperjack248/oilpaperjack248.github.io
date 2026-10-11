# STREAMING_CHUNK:Configuring Render blueprint for static web app deployment...
services:
  - type: web
    name: phonedrop-telegram-mini-app
    env: static
    staticPublishPath: ./
    buildCommand: ""
    headers:
      - path: /*
        name: Cache-Control
        value: no-cache, no-store, must-revalidate