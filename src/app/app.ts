import { Component, inject } from '@angular/core';
import { UiModeService } from './core/ui-mode.service';
import { ElevationProfile } from './elevation-profile/elevation-profile';
import { MapView } from './map-view/map-view';
import { Sidebar } from './sidebar/sidebar';

@Component({
  selector: 'app-root',
  imports: [Sidebar, MapView, ElevationProfile],
  template: `
    @if (!ui.simple()) {
      <app-sidebar />
    }
    <main>
      <app-map-view />
      @if (!ui.simple()) {
        <app-elevation-profile />
      }
    </main>
  `,
  styleUrl: './app.scss',
  host: { '[class.simple]': 'ui.simple()' },
})
export class App {
  protected ui = inject(UiModeService);
}
