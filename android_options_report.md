# Informe Técnico: Alternativas de Generación de APK para ChequeClaro Android v1

**Autor:** Manus AI  
**Fecha:** 13 de agosto de 2026  
**Proyecto:** ChequeClaro Android v1 (React Native + Expo SDK 52)  

---

## 1. ¿El proyecto Android requiere una cuenta Expo para generar el APK?

**Sí, parcialmente.**  
El servicio de compilación en la nube de Expo (**EAS Build**) exige obligatoriamente una cuenta de usuario autenticada en Expo [1] para encolar y ejecutar el proceso de empaquetado remoto (`eas build --platform android`). 

Sin embargo, a nivel de código fuente y empaquetado técnico, una aplicación desarrollada con Expo y React Native **no depende funcionalmente de una cuenta en el dispositivo final**. El código contenido en `/home/ubuntu/cheque-claro-android` es un proyecto estándar con dependencias de React Native CLI (`react-native-screens`, `expo-image-picker`, etc.) que puede compilarse de forma puramente nativa sin conexión a los servidores de Expo si se utiliza el flujo nativo de Android (Gradle).

---

## 2. ¿Qué cuenta Expo está configurada actualmente?

Actualmente **no existe ninguna cuenta Expo configurada** ni sesión activa en el entorno de ejecución (`eas whoami` responde *"Not logged in"* y la variable `EXPO_TOKEN` no está definida). Al no haberse vinculado previamente ningún perfil, EAS Build no dispone de credenciales de propietario para iniciar el proceso en la nube.

---

## 3. ¿Podemos crear una cuenta Expo nueva desde el flujo normal de EAS?

**Sí.**  
Si se desea utilizar EAS Build, el comando interactivo `npx eas-cli login` permite registrar una cuenta gratuita de Expo o iniciar sesión de forma guiada en pocos segundos. No obstante, dado que el usuario ha indicado expresamente que no desea proporcionar contraseñas ni tokens de acceso, este camino queda descartado para esta iteración.

---

## 4. ¿Existe una alternativa para generar un APK localmente sin Expo/EAS?

**Sí, mediante Expo Prebuild y Gradle Local (Native Android Export).**  
Expo permite desacoplar el proyecto gestionado de los servicios en la nube utilizando el comando de preconstrucción nativa (`npx expo prebuild`), el cual genera la carpeta `android/` con todo el código fuente en Java/Kotlin y la estructura estándar de Gradle. 

A partir de ahí, el APK se puede compilar directamente en una máquina con el SDK de Android instalado ejecutando:
```bash
cd android
./gradlew assembleRelease
```
*Limitación en el sandbox actual:* El entorno aislado de pruebas (sandbox Linux de Manus) no cuenta con el SDK de Android nativo completo ni con las herramientas de compilación de Gradle preinstaladas (Android Build Tools, NDK y JDK configurados para compilación nativa móvil), por lo que un build local directo en el servidor requeriría la descarga e instalación pesada de los binarios de Android Studio / Command Line Tools.

---

## 5. Opciones Disponibles y Recomendación

A continuación se comparan objetivamente las alternativas analizadas para la entrega del APK:

| Opción | Requisitos | Ventajas | Desventajas |
| :--- | :--- | :--- | :--- |
| **A. EAS Build (Nube de Expo)** | Cuenta gratuita de Expo / `EXPO_TOKEN` | Generación automática en servidores remotos sin configurar SDK de Android local. | Requiere autenticación inicial del usuario. |
| **B. Prebuild + Gradle Local** | Android SDK, JDK, Gradle instalados localmente | Control total del código nativo sin depender de servicios de terceros. | Requiere entorno de desarrollo móvil configurado en la máquina del usuario (Windows 11). |
| **C. Expo Go (Ejecución Directa)** | App "Expo Go" instalada en el teléfono Android | Permite probar la app de inmediato escaneando un código QR con la API ya conectada. | No genera un archivo `.apk` independiente para distribución final de producción. |

### Recomendación para el usuario

Teniendo en cuenta que el backend, la API unificada (`POST /api/cheques/analyze`), la persistencia en Supabase REST y la interfaz web están **100% estabilizadas y operativas**, y que el cliente Android en React Native ya contiene toda la lógica de captura, compresión, configuración de URL y renderizado multi-CUIT:

1. **Para pruebas inmediatas sin compilar APK:** Se recomienda ejecutar `npx expo start` dentro de la carpeta `/home/ubuntu/cheque-claro-android` y abrir la app escaneando el código QR con la aplicación gratuita **Expo Go** en un teléfono Android conectado a la misma red o mediante túnel.
2. **Para obtener el APK definitivo:** Cuando se disponga de un entorno local con Android Studio o se decida autenticar una cuenta gratuita de Expo en el futuro, se podrá ejecutar el build en un solo comando sin necesidad de modificar ni una sola línea de código de ChequeClaro.

---
*Fin del informe técnico.*
