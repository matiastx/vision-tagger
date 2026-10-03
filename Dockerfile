# vision-tagger
FROM node:20-alpine
WORKDIR /app
COPY package.json tagger.mjs ./
CMD ["node", "tagger.mjs"]
