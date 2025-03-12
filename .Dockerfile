FROM node:16
WORKDIR /app
# Copia los archivos de configuración y dependencias
COPY package*.json ./
RUN npm install
# Copia el resto de la aplicación
COPY . .
# Expone el puerto que usas (en tu código usas process.env.PORT || 3000)
EXPOSE 3000
CMD ["node", "index.js"]
