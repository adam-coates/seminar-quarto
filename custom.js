<script>
function getSeminarMenu() {
  var seminarMenu =
    '<p class="slide-menu-item" id="broadcast">' +
    "<form>" +
    "<table>" +
    '<tr><td> User name:</td><td> <input type="text" id="username" style="font-size:80%;" size="13"></td></tr>' +
    '<tr><td> Password:</td><td> <input type="password" id="password" style="font-size:80%;" size="13"></td></tr>' +
    "</table>" +
    '<button id="startSeminar" type="submit" style="margin:10px;">Start</button><button id="stopSeminar"  style="margin:10px;">Stop</button>' +
    "</form>" +
    "<p>Status log:</p>" +
    '<textarea id="logger" spellcheck="false" readonly style="width:100%;height:calc(100% - 180px);background-color:black;color:white;">Trying to connect to server ...\n</textarea>' +
    "</p>";
  return seminarMenu;
}

function initSeminarMenu() {
  var element = document.getElementById("broadcast");
  if (element) {
    // make sure that events are not propagated
    element.parentElement.addEventListener(
      "keydown",
      consumeBroadcastEvent,
    );

    var startButton = document.getElementById("startSeminar");
    if (startButton) {
      startButton.addEventListener("click", function (evt) {
        evt.preventDefault();
        RevealSeminar.open_or_join_room(
          document.getElementById("password").value,
          (document.getElementById("username") || {}).value || "Lecturer",
        );
      });
    }

    var stopButton = document.getElementById("stopSeminar");
    if (stopButton) {
      stopButton.addEventListener("click", function (evt) {
        evt.preventDefault();
        if (
          confirm(
            "Are you sure you want to close the seminar for all participants?",
          )
        ) {
          RevealSeminar.close_room(
            document.getElementById("password").value,
          );
        }
      });
    }
  } else {
    setTimeout(initSeminarMenu, 100);
  }
}

function consumeBroadcastEvent(evt) {
  evt.stopPropagation();
}

function seminarStatusLogger(message) {
  if (!isConnected) {
    // hide elements that are only displayed when not connected
    var showOnDisconnected =
      document.querySelectorAll(".seminar.disconnected") || [];
    for (var i = 0; i < showOnDisconnected.length; i++) {
      showOnDisconnected[i].style.display = "none";
    }

    // show elements that are only displayed when connected
    var showOnConnected =
      document.querySelectorAll(".seminar.connected") || [];
    for (var i = 0; i < showOnConnected.length; i++) {
      showOnConnected[i].style.display = "";
    }
    isConnected = true;
  }
  var element = document.getElementById("logger");
  if (element) {
    while ((element.value.match(/\n/g) || []).length >= 10) {
      // Limit number of lines in log to 10
      element.value = element.value.substring(
        element.value.indexOf("\n") + 1,
      );
    }
    element.value += "> " + message + "\n";
  }
}

initSeminarMenu();
</script>
