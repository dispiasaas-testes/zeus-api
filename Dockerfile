# Usa a imagem oficial do Node.js (versão 20)
FROM node:20-alpine

# Define o diretório de trabalho dentro do contêiner
WORKDIR /usr/src/app

# Copia os arquivos de dependência primeiro (para aproveitar o cache do Docker)
COPY package*.json ./

# Instala todas as dependências
RUN npm install

# Copia todo o código fonte para dentro do contêiner
COPY . .

# Compila o TypeScript para JavaScript na pasta /dist
RUN npm run build

# Expõe a porta que a nossa API usa
EXPOSE 3000

# Comando para iniciar a aplicação compilada
CMD ["npm", "start"]