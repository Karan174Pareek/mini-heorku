FROM node:20-alpine

RUN apk add --no-cache git curl bash file

WORKDIR /app

COPY package.json ./
RUN npm install --production

COPY server.js init-repo.sh ./
RUN chmod +x init-repo.sh

RUN mkdir -p /repos

EXPOSE 8080

CMD ["node", "server.js"]

