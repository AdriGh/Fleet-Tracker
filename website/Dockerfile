# Sitio de marketing Rigsmith — build estatico + nginx.
# En Dokploy: Application con Build Type "Dockerfile",
#   Docker Context Path: website
#   Docker File:         website/Dockerfile
# El contenedor expone el puerto 80 (mapear en el dominio de Dokploy).

FROM node:22-alpine AS build
WORKDIR /site
COPY package.json package-lock.json ./
RUN npm ci
COPY . .
RUN npm run build

FROM nginx:1.27-alpine
COPY --from=build /site/dist /usr/share/nginx/html
COPY nginx.conf /etc/nginx/conf.d/default.conf
EXPOSE 80
