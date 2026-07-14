function detectTaskList() {
  var taskListObjects = document.querySelectorAll('li input[type="checkbox"]');
  for (var i = 0; i < taskListObjects.length; i++) {
    var item = taskListObjects[i].closest('li');
    var list = item ? item.parentNode : null;
    if (!item) continue;
    item.classList.add("task-list-item");
    if (list) list.classList.add("task-list");
  }
}

function detectBlockTable() {
  var tableListObjects = document.querySelectorAll("table > thead");
  for (var i = 0; i < tableListObjects.length; i++) {
    var par = tableListObjects[i].parentNode;
    par.classList.add("block-table");
  }
}

function detectors(){
  detectTaskList();
  detectBlockTable();
}

if (document.readyState === "loading") {
  document.addEventListener("DOMContentLoaded", detectors);
} else {
  detectors();
}


