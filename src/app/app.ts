import { Component } from '@angular/core';
import { ElevationProfile } from './elevation-profile/elevation-profile';
import { MapView } from './map-view/map-view';
import { Sidebar } from './sidebar/sidebar';

@Component({
  selector: 'app-root',
  imports: [Sidebar, MapView, ElevationProfile],
  template: `
    <app-sidebar />
    <main>
      <app-map-view />
      <app-elevation-profile />
    </main>
  `,
  styleUrl: './app.scss',
})
export class App {}
