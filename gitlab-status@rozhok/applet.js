const Applet = imports.ui.applet;
const Clutter = imports.gi.Clutter;
const GLib = imports.gi.GLib;
const Lang = imports.lang;
const Mainloop = imports.mainloop;
const PopupMenu = imports.ui.popupMenu;
const St = imports.gi.St;
const Soup = imports.gi.Soup;
const Settings = imports.ui.settings;
const Util = imports.misc.util;
const ByteArray = imports.byteArray;
const Gio = imports.gi.Gio;

// Configuration variables
const API_URL = "https://gitlab.com/api/v4";
const UPDATE_INTERVAL = 60; // Update interval in seconds
const RECENT_DAYS = 2; // Number of days to consider a pipeline recent

// Pipeline status constants
const STATUS = {
  RUNNING: "running",
  FAILED: "failed",
  SUCCESS: "success",
  UNKNOWN: "unknown"
};

// Colors based on status
const COLORS = {
  [STATUS.RUNNING]: global.userdatadir + "/applets/gitlab-status@rozhok/icons/blue.svg",
  [STATUS.FAILED]: global.userdatadir + "/applets/gitlab-status@rozhok/icons/red.svg",
  [STATUS.SUCCESS]: global.userdatadir + "/applets/gitlab-status@rozhok/icons/green.svg",
  [STATUS.UNKNOWN]: global.userdatadir + "/applets/gitlab-status@rozhok/icons/gray.svg"
};

function GitLabStatusApplet(orientation, panel_height, instance_id) {
  this._init(orientation, panel_height, instance_id);
}

GitLabStatusApplet.prototype = {
  __proto__: Applet.IconApplet.prototype,

  _init: function (orientation, panel_height, instance_id) {
    Applet.IconApplet.prototype._init.call(this, orientation, panel_height, instance_id);

    this.settings = new Settings.AppletSettings(this, "gitlab-status@rozhok", instance_id);
    this.settings.bind("gitlab-token", "gitlab_token", this._onSettingsChanged);
    this.settings.bind("gitlab-url", "gitlab_url", this._onSettingsChanged);
    this.settings.bind("update-interval", "update_interval", this._onSettingsChanged);

    // Initialize default values if settings are empty
    this.gitlab_token = this.gitlab_token || null;
    this.gitlab_url = this.gitlab_url || API_URL;
    this.update_interval = this.update_interval || UPDATE_INTERVAL;

    // Initialize Soup session
    this.httpSession = new Soup.Session();

    this.set_applet_tooltip(_("GitLab Pipeline Status"));
    this.set_applet_icon_path(COLORS[STATUS.UNKNOWN]);

    // Initialize menu
    this.menuManager = new PopupMenu.PopupMenuManager(this);
    this.menu = new Applet.AppletPopupMenu(this, orientation);
    this.menu.box.style = "padding: 0px; margin: 0px;";
    this.menuManager.addMenu(this.menu);

    // Items container
    this._pipelinesSection = new PopupMenu.PopupMenuSection();
    this.menu.addMenuItem(this._pipelinesSection);

    // Start the periodic update
    this._timeout = Mainloop.timeout_add_seconds(this.update_interval, Lang.bind(this, this._refreshStatus));

    // Initial refresh
    this._refreshStatus();
  },

  _onSettingsChanged: function () {
    // Update timer if interval changed
    if (this._timeout) {
      Mainloop.source_remove(this._timeout);
      this._timeout = Mainloop.timeout_add_seconds(this.update_interval, Lang.bind(this, this._refreshStatus));
    }

    this._refreshStatus();
  },

  _refreshStatus: function () {
    if (this.gitlab_token == null) {
      return;
    }
    this._getProjects();

    return true;
  },

  _getProjects: function () {
    let projectsUrl = this.gitlab_url + "/projects?membership=true&per_page=100";
    this._makeRequest(projectsUrl, (data) => {
      this._getProjectPipelines(data);
    });
  },

  _makeRequest: function (url, callback) {
    try {
      let req = Soup.Message.new("GET", url);
      req.request_headers.append("PRIVATE-TOKEN", this.gitlab_token);

      this.httpSession.send_and_read_async(req, Soup.MessagePriority.NORMAL, null, (session, res) => {
        const bytes = this.httpSession.send_and_read_finish(res);
        if (bytes) {
          const data = JSON.parse(ByteArray.toString(bytes.get_data()));
          callback(data);
        }
      });
    } catch (e) {
      global.logError("GitLab Pipeline Status: Error making request: " + e);
    }
  },

  _getProjectPipelines: function (projects) {
    let overallStatus = STATUS.UNKNOWN;
    let projectPipelines = [];
    let completedRequests = 0;
    let totalRequests = projects.length;
    let oneWeekAgoDate = new Date();
    oneWeekAgoDate.setDate(new Date().getDate() - RECENT_DAYS);

    for (let i = 0; i < projects.length; i++) {
      let project = projects[i];
      let pipelines_url = this.gitlab_url + "/projects/" + project.id + "/pipelines?created_after=" + oneWeekAgoDate.toISOString();

      this._makeRequest(pipelines_url, (pipelines) => {
        completedRequests++;

        if (pipelines && pipelines.length > 0) {
          // Get the most recent pipeline
          let pipeline = pipelines[0];

          projectPipelines.push({
            project_name: project.name_with_namespace,
            status: pipeline.status,
            url: pipeline.web_url,
            ref: pipeline.ref,
          });

          // Update overall status
          if (pipeline.status === STATUS.RUNNING) {
            overallStatus = STATUS.RUNNING;
          } else if (pipeline.status === STATUS.FAILED && overallStatus !== STATUS.RUNNING) {
            overallStatus = STATUS.FAILED;
          } else if (pipeline.status === STATUS.SUCCESS &&
            overallStatus !== STATUS.RUNNING &&
            overallStatus !== STATUS.FAILED) {
            overallStatus = STATUS.SUCCESS;
          }
        }

        // If this is the last response, update the UI
        if (completedRequests === totalRequests) {
          this._updateUi(projectPipelines, overallStatus);
        }
      });
    }
  },

  _updateUi: function (projectPipelines, overallStatus) {
    // Clear existing menu items
    this._pipelinesSection.removeAll();
    this.set_applet_icon_path(COLORS[overallStatus]);

    if (projectPipelines.length === 0) {
      let item = new PopupMenu.PopupMenuItem(_("No recent pipelines found"));
      this._pipelinesSection.addMenuItem(item);
      return;
    }

    // Add menu items for each pipeline
    for (let i = 0; i < projectPipelines.length; i++) {
      let pipeline = projectPipelines[i];

      // Create a horizontal box layout
      let hbox = new St.BoxLayout({
          style_class: "popup-menu-item",
          style: "padding: 2px; margin: 0;"
        }
      );

      let icon = new St.Icon({
        gicon: Gio.icon_new_for_string(COLORS[pipeline.status]),
        icon_size: 16,
      });
      hbox.add(icon);

      // Project name with branch
      let label = new St.Label({
        text: pipeline.project_name + " (" + pipeline.ref + ")",
        style_class: "popup-menu-item-label"
      });
      hbox.add(label);

      // Create the menu item with our custom layout
      let item = new PopupMenu.PopupBaseMenuItem();
      item.addActor(hbox);

      // URL to open when clicked
      item.connect("activate", function () {
        Util.spawnCommandLine("xdg-open " + pipeline.url);
      });

      this._pipelinesSection.addMenuItem(item);
    }
  },

  on_applet_clicked: function () {
    this.menu.toggle();
  },

  on_applet_removed_from_panel: function () {
    if (this._timeout) {
      Mainloop.source_remove(this._timeout);
      this._timeout = null;
    }
  }
};

function main(metadata, orientation, panel_height, instance_id) {
  return new GitLabStatusApplet(orientation, panel_height, instance_id);
}
