FROM eclipse-temurin:17-jre
WORKDIR /app
COPY target/timemark-server.jar app.jar
EXPOSE 8080
ENTRYPOINT ["java", "-Xms128m", "-Xmx512m", "-jar", "app.jar"]
