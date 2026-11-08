# Checklist 028 — probar notas y conversaciones desde el celular (tareas del humano)

Estado al 2026-11-08: código T1–T68 listo y todos los criterios con test citado; faltan los pasos que solo se ven en un teléfono real (AC-2.13, 5.5, 6.1, 6.2, 6.4, 6.7, 6.9, 6.10, 6.12, 7.3) y los manuales de T23, T36, T38, T43, T58, T59, T62 y T68. La spec sigue en `ready`: la pasás a `implemented` vos, después de esta pasada.

## 0. Prerrequisitos

- [x] `pnpm run build:remote` (deja la PWA nueva en `out/remote`).
- [x] Cerrar Alma del todo (también la bandeja) y volver a abrirla: los cambios del coordinador no se recargan solos.
- [x] Tailscale conectado en la PC y en el teléfono; el teléfono ya emparejado (026). Si no, emparejar primero.
- [x] Abrir la app instalada **dos veces** (cerrarla del todo entre una y otra): la primera baja el service worker nuevo, la segunda ya corre con el caché `alma-shell-v9` (el viejo se borra solo). Si algo se ve a medias o sin Notas, es el caché: repetir.
- [X] Tener en la bóveda activa: una carpeta con varias notas, una nota con imágenes, una nota larga, una carpeta vacía y una carpeta "privada" para excluir.
- [X] Tener 2 o 3 conversaciones en la PC (una con otro agente, una de Telegram si hay) y que ninguna sea de una empresa.

## 1. Gates automáticos (en esta máquina)

- [ ] `pnpm run check:fast` en verde.
- [ ] `pnpm run check` en verde (coverage + require-tests).

## 2. En la PC: pestaña "Acceso remoto" (AC-1.2, 1.3, 1.8, 1.10, 1.11)

- [X] Prender el acceso remoto: **Notas**, **Conversaciones** y **Continuar conversaciones** arrancan apagados (también si lo apagás y lo prendés de nuevo).
- [x] Prender **Notas (solo lectura)**: sale un diálogo del sistema (no de la página; probá clickearlo desde DevTools y no se puede) que nombra la carpeta de la bóveda. "Cancelar" lo deja apagado; "Permitir" lo prende.
- [x] Excluir una carpeta en "Carpetas excluidas del celular": se aplica al instante, sin diálogo. Cerrar y reabrir Alma: la exclusión sigue.
- [X] Sacar la exclusión: ahí sí sale un diálogo nativo que nombra la carpeta.
- [x] Renombrar la carpeta excluida desde la vista de bóveda de Alma: la exclusión la sigue. Renombrarla desde el Explorador de Windows: aparece como "ya no existe en esa ruta" y la carpeta nueva NO queda excluida.
- [x] Prender **Conversaciones**: diálogo nativo. El sub-interruptor **Continuar conversaciones desde el celular** solo aparece con Conversaciones prendido y pide su propio diálogo (dice que el teléfono puede hacer trabajar a tus agentes).
- [x] Apagar cualquiera de los tres: no pide confirmación. Apagar Conversaciones apaga también el sub-interruptor.

## 3. En el teléfono: Notas (AC-2.13, 6.1, 6.2)

Barra de abajo con cinco destinos: Chat, Notas, Casa, Cámaras, Ajustes; el actual está marcado.

- [x] Con Notas prendido: abrir el destino Notas, ver la raíz (carpetas primero), entrar a una carpeta y abrir una nota.
- [x] Buscar por nombre: aparecen hasta 50, de toda la bóveda; una búsqueda sin coincidencias dice "Ninguna nota coincide"; la carpeta excluida nunca aparece.
- [x] Carpeta vacía: "Esta carpeta está vacía". Con la bóveda cerrada en la PC: "No hay una bóveda abierta en la PC".
- [x] La nota se ve como en la PC: sin frontmatter, sin HTML crudo, `[[wiki]]` como texto. Un link a otra nota la abre dentro; un link externo solo abre al tocarlo.
- [x] Una nota con imágenes: se ven; una imagen de más de 2 MB muestra el aviso y el resto de la nota sigue.
- [x] Una nota muy larga: se lee y hace scroll sin trabarse. Una de más de 1 MB dice que es demasiado grande.
- [x] Un archivo que no es nota ni imagen (un PDF): aparece en la lista pero al abrirlo dice que no se puede ver.
- [x] Probar abrir algo de la carpeta excluida (link directo desde una nota visible): dice "Esta nota no está disponible", igual que una que no existe.
- [x] Apagar Notas en la PC con una nota abierta: al siguiente pedido la nota desaparece y se ve el estado "apagado en la PC", sin recargar la app.
- [x] Volver: el gesto de atrás del sistema sube un nivel (nota a carpeta, carpeta a la de arriba, conversación a la lista) y recién en el nivel de arriba sale de la app. En Android con el gesto, en iPhone con el botón "Volver" y el swipe de borde.
- [x] Salir de la app y volver: pide la nota de nuevo (no queda nada guardado).

## 4. En el teléfono: Conversaciones (AC-3.x)

- [ ] En el Chat, la entrada "Conversaciones": lista de 30 en 30 con "Ver más"; no aparecen conversaciones de empresas; la del chat de este celular está marcada.
- [ ] Abrir una: se leen los últimos mensajes, solo texto (sin herramientas), "Ver mensajes anteriores" pagina. Una abierta que no es la del celular tiene botón de refrescar.
- [ ] Con **Continuar** apagado: no hay caja para escribir y el texto dice que está apagado en la PC.
- [ ] Con **Continuar** prendido: escribir en una conversación de la PC. La respuesta vuelve al teléfono y también se ve en la PC, con el agente, el modelo y la carpeta de esa conversación.
- [ ] Mientras la PC corre esa conversación (mandá algo desde la PC): el teléfono dice "en uso en la PC" y no manda.
- [ ] Una segunda respuesta desde el mismo teléfono mientras la primera sigue: "Ya hay una respuesta en curso desde este celular".
- [ ] Parar una respuesta que arrancó el celular: se corta como en la PC.
- [ ] Continuar una conversación de Telegram desde el celular: no sale ningún mensaje a Telegram.
- [ ] Aprobación: con **Aprobar** prendido, pedir algo que pregunte (una herramienta que escribe, en un modo que pregunte). La tarjeta aparece en el teléfono marcada con la conversación, se contesta una vez, y no ofrece "Siempre permitir". Llega el push de "Alma te necesita" sin contenido.
- [ ] Con **Aprobar** apagado: el teléfono dice "Esperando una aprobación en la PC" y la aprobación sigue pendiente en la PC.
- [ ] Una aprobación de una corrida que arrancó la PC en otra conversación: el teléfono NO la ve.
- [ ] Borrar la conversación en la PC mientras está abierta en el teléfono: "Esta conversación ya no existe".
- [ ] Apagar el sub-interruptor o Conversaciones en la PC con una respuesta del celular en curso: se corta, y lo ya escrito queda.

## 5. Corte y revocación (AC-3.20, 1.6)

- [ ] Kill switch de la bandeja ("Apagar el acceso remoto") con una respuesta del celular en curso: se corta, y el teléfono muestra que la PC no responde.
- [ ] Volver a prender el remoto: Notas, Conversaciones y Continuar vuelven apagados.
- [ ] Revocar el teléfono en la PC (con y sin una respuesta en curso): al reabrir la PWA muestra "revocado" y se limpia; no queda ninguna nota ni conversación a la vista.

## 6. Actividad en la PC (AC-5.5)

- [ ] Después de leer una nota, abrir una conversación, mandar y parar: la lista de actividad remota muestra las entradas con nombre del teléfono, hora y qué (la ruta de la nota o el id de la conversación; nunca texto).
- [ ] Un extraño (otro dispositivo o token inválido) pidiendo algo: entrada de denegado, sin nombres ni contenido.

## 7. Cosas que los tests sin teléfono no ven (AC-6.4, 6.7, 6.9, 6.10, 6.12)

- [ ] Áreas seguras: en iPhone con notch y en Android con gestos, la barra de abajo y el encabezado no quedan tapados.
- [ ] Teclado sobre el compositor: al escribir en una conversación y en el Chat, la caja y el botón siguen visibles y la barra no tapa nada. Probar vertical y horizontal.
- [ ] Vidrio: el desenfoque de la barra y las tarjetas se ve bien (sin recuadros negros ni parpadeos) en Android y iPhone.
- [ ] Movimiento: con "reducir movimiento" prendido en el teléfono, el fondo y las transiciones se calman.
- [ ] Sin sonidos ni música en ninguna pantalla.
- [ ] Lector de pantalla (TalkBack / VoiceOver): la barra anuncia el destino actual; los botones tienen nombre; las listas se leen; los estados (cargando, vacío, error) se anuncian.
- [ ] Texto al 200 %: nada se corta ni queda tapado, los botones siguen tocables.
- [ ] Blancos táctiles cómodos (44 px), foco visible con teclado externo, contraste legible al sol.
- [ ] Texto largo: una nota con CRLF, emojis o una línea larguísima no rompe el layout; un título de conversación con emojis tampoco.
- [ ] La foto de una cámara (Cámaras → pedir una foto) ahora se ve (antes el CSP la bloqueaba; ya permite `data:` solo para imágenes).
- [ ] PC dormida / Alma cerrada / Tailscale caído: cada pantalla dice "La PC no responde", reintenta sola y el botón "Reintentar" prueba al toque; lo que estabas escribiendo queda en la caja.
- [ ] Ajustes: muestra la conexión, "Lo que este celular puede hacer ahora" (chat, aprobar, casa, cámaras, cerraduras y alarmas, notas, conversaciones, continuar), la versión y "Olvidar esta PC" con confirmación; no hay selector de idioma ni ningún interruptor de alcance.
- [ ] Idioma: con el teléfono en español y después en inglés, todo sale en ese idioma, sin textos mezclados ni claves crudas.

## 8. Docs (AC-7.3)

- [ ] Leer el diff del PR contra el §7 de la spec: R-14 (el teléfono arranca corridas en conversaciones de escritorio; en "Permitir todo" `exec` y `write` no preguntan), CONTROLS, PRIVACY, glosario y las enmiendas a 026, 022, 008, 009, 004, 002, 006, 023 y 025.

## 9. Cierre

- [ ] Todo lo anterior hecho: spec 028 a `status: implemented` (`pnpm exec vitest run tests/specs.test.ts` tiene que seguir verde) y fila del README.
- [ ] Recordar que R-01 sigue bloqueando el release y que 026 sigue con sus propios pendientes (CHECKLIST-026).

## Qué contarme

- Qué pasos fallaron, en qué teléfono (modelo y versión de Android o iOS) y si lo abriste desde la app instalada o desde una pestaña.
- Una captura o una frase de lo que viste en vez de lo esperado (el texto exacto del error si hay).
- Si algo se sintió lento: cuánto tardó y en qué pantalla.
- Cualquier cosa que el teléfono pudo ver o hacer y no debería (una nota de la carpeta excluida, una conversación de empresa, una aprobación ajena): eso es lo más importante.
