import { observable } from 'mobx';

export class PrecompileStore {
  @observable accessor ready = false;
  @observable accessor compiled = 0;
  @observable accessor toCompile = 0;
}
